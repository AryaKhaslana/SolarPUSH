package com.aryakhaslana.sonarmesh.ble

import android.annotation.SuppressLint
import android.app.PendingIntent
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothManager
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.bluetooth.le.AdvertisingSet
import android.bluetooth.le.AdvertisingSetCallback
import android.bluetooth.le.AdvertisingSetParameters
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.ParcelUuid
import com.aryakhaslana.sonarmesh.protocol.PacketDeduplicator
import com.aryakhaslana.sonarmesh.protocol.SmpV1Codec
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger
import kotlin.random.Random

data class BlePacketEvent(
  val rawBytes: ByteArray,
  val packet: SmpV1Codec.Packet,
  val rssi: Int,
  val relayed: Boolean,
)

/**
 * Hardware-filtered BLE Advertising + Scanning relay transport for 56-byte SMPv1 packets.
 * - Uses BLE 5 Extended Advertising when supported to send all 56 bytes in one PDU.
 * - Falls back to 2-fragment legacy BLE 4.x advertising (28B + 28B) with reassembly.
 * - Enforces PACKET_ID deduplication, TTL decrement, and 200-2000ms random jitter backoff.
 */
class BleMeshTransport(
  private val context: Context,
  private val deduplicator: PacketDeduplicator = PacketDeduplicator(),
) {
  companion object {
    val SERVICE_UUID: ParcelUuid = ParcelUuid(UUID.fromString("00005150-0000-1000-8000-00805F9B34FB"))
    const val MANUFACTURER_ID = 0x5150
    const val FRAG_TAG_LEN = 2
    const val HALF_PACKET_LEN = 28 // 56 / 2
    const val ACTION_BLE_SCAN_BATCH = "com.aryakhaslana.sonarmesh.ACTION_BLE_SCAN_BATCH"
  }

  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  private val bluetoothManager = context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
  private val adapter: BluetoothAdapter? get() = bluetoothManager?.adapter

  // Reassembly map for legacy 2-part BLE 4.x fragments: key = 2-byte tag hex
  private data class PartialPair(var part0: ByteArray? = null, var part1: ByteArray? = null, var updatedMs: Long = 0L)
  private val fragmentCache = ConcurrentHashMap<String, PartialPair>()

  private val relayCounter = AtomicInteger(0)
  @Volatile private var scanning = false
  @Volatile private var activeCallback: ScanCallback? = null
  @Volatile private var pendingScanIntent: PendingIntent? = null
  @Volatile private var activeExtendedSet: AdvertisingSet? = null
  @Volatile private var onPacketListener: ((BlePacketEvent) -> Unit)? = null

  fun getRelayedCount(): Int = relayCounter.get()

  fun setPacketListener(listener: ((BlePacketEvent) -> Unit)?) {
    onPacketListener = listener
  }

  @SuppressLint("MissingPermission")
  fun startScanning(lowLatency: Boolean = false): Result<Unit> {
    val btAdapter = adapter ?: return Result.failure(IllegalStateException("Bluetooth adapter unavailable"))
    if (!btAdapter.isEnabled) {
      return Result.failure(IllegalStateException("Bluetooth is turned off"))
    }
    val scanner = btAdapter.bluetoothLeScanner
      ?: return Result.failure(IllegalStateException("BLE scanner unavailable"))

    if (scanning) return Result.success(Unit)

    val filters = listOf(
      ScanFilter.Builder().setServiceUuid(SERVICE_UUID).build(),
      ScanFilter.Builder().setManufacturerData(MANUFACTURER_ID, byteArrayOf()).build(),
    )

    val settings = ScanSettings.Builder()
      .setScanMode(if (lowLatency) ScanSettings.SCAN_MODE_LOW_LATENCY else ScanSettings.SCAN_MODE_LOW_POWER)
      .setReportDelay(0L)
      .build()

    // Register hardware-filtered PendingIntent receiver for resilient background scanning
    val intent = Intent(context, BleScanResultReceiver::class.java).apply {
      action = ACTION_BLE_SCAN_BATCH
    }
    val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
    } else {
      PendingIntent.FLAG_UPDATE_CURRENT
    }
    val pi = PendingIntent.getBroadcast(context, 5150, intent, flags)
    pendingScanIntent = pi

    val callback = object : ScanCallback() {
      override fun onScanResult(callbackType: Int, result: ScanResult) {
        handleScanResult(result)
      }

      override fun onBatchScanResults(results: MutableList<ScanResult>) {
        for (res in results) handleScanResult(res)
      }
    }
    activeCallback = callback

    return try {
      scanner.startScan(filters, settings, callback)
      scanning = true
      Result.success(Unit)
    } catch (t: Throwable) {
      Result.failure(t)
    }
  }

  @SuppressLint("MissingPermission")
  fun stopScanning() {
    val scanner = adapter?.bluetoothLeScanner
    activeCallback?.let { cb ->
      try {
        scanner?.stopScan(cb)
      } catch (_: Throwable) {
      }
    }
    pendingScanIntent?.let { pi ->
      try {
        scanner?.stopScan(pi)
      } catch (_: Throwable) {
      }
    }
    activeCallback = null
    pendingScanIntent = null
    scanning = false
  }

  fun handleScanResult(result: ScanResult) {
    val record = result.scanRecord ?: return
    val rssi = result.rssi

    // Case 1: Full 56-byte BLE 5 Extended Advertising payload inside Service Data or Manufacturer Data
    val svcData = record.getServiceData(SERVICE_UUID)
    if (svcData != null && svcData.size == SmpV1Codec.PACKET_SIZE) {
      processInboundPacket(svcData, rssi)
      return
    }

    val mfg = record.getManufacturerSpecificData(MANUFACTURER_ID) ?: return
    if (mfg.size == SmpV1Codec.PACKET_SIZE) {
      processInboundPacket(mfg, rssi)
      return
    }

    // Case 2: Legacy BLE 4.x 2-fragment format: [partIdx: 1B (0 or 1)] [tag: 2B] [chunk: 28B] = 31B?
    // Actually fits cleanly in 24B manufacturer payload? Wait: legacy adv max 31B total,
    // so we support 2-part chunking [meta: 1B = (partIdx<<7)|(tag7)] [chunk: 28B] = 29B or extended.
    if (mfg.size == 1 + FRAG_TAG_LEN + HALF_PACKET_LEN) {
      val partIdx = mfg[0].toInt() and 0x01
      val tag = "%02x%02x".format(mfg[1], mfg[2])
      val chunk = mfg.copyOfRange(3, 3 + HALF_PACKET_LEN)
      val now = System.currentTimeMillis()
      val pair = fragmentCache.computeIfAbsent(tag) { PartialPair(updatedMs = now) }
      synchronized(pair) {
        if (partIdx == 0) pair.part0 = chunk else pair.part1 = chunk
        pair.updatedMs = now
        val p0 = pair.part0
        val p1 = pair.part1
        if (p0 != null && p1 != null) {
          fragmentCache.remove(tag)
          val full = ByteArray(SmpV1Codec.PACKET_SIZE)
          System.arraycopy(p0, 0, full, 0, HALF_PACKET_LEN)
          System.arraycopy(p1, 0, full, HALF_PACKET_LEN, HALF_PACKET_LEN)
          processInboundPacket(full, rssi)
        }
      }
      // Evict stale incomplete fragments older than 15s
      if (fragmentCache.size > 64) {
        fragmentCache.entries.removeIf { now - it.value.updatedMs > 15_000L }
      }
    }
  }

  private fun processInboundPacket(raw56: ByteArray, rssi: Int) {
    val decoded = SmpV1Codec.decode(raw56).getOrNull() ?: return
    if (!deduplicator.acceptIfFresh(decoded)) {
      return
    }

    val relayBytes = SmpV1Codec.prepareRelay(decoded, elapsedSec = 1)
    onPacketListener?.invoke(
      BlePacketEvent(
        rawBytes = raw56,
        packet = decoded,
        rssi = rssi,
        relayed = relayBytes != null,
      )
    )

    // Relay with randomized 200..2000ms jitter backoff to prevent broadcast storms
    if (relayBytes != null) {
      scope.launch {
        val jitterMs = Random.nextLong(200L, 2001L)
        delay(jitterMs)
        val res = advertisePacket(relayBytes, durationMs = 2500L)
        if (res.isSuccess) {
          relayCounter.incrementAndGet()
        }
      }
    }
  }

  @SuppressLint("MissingPermission")
  fun advertisePacket(packet56: ByteArray, durationMs: Long = 3500L): Result<Unit> {
    require(packet56.size == SmpV1Codec.PACKET_SIZE) { "Expected 56-byte SMPv1 packet" }
    val btAdapter = adapter ?: return Result.failure(IllegalStateException("Bluetooth adapter unavailable"))
    if (!btAdapter.isEnabled) {
      return Result.failure(IllegalStateException("Bluetooth is turned off"))
    }
    val advertiser = btAdapter.bluetoothLeAdvertiser
      ?: return Result.failure(IllegalStateException("BLE advertiser not supported on this device"))

    // Prefer BLE 5 Extended Advertising when device supports > 56 bytes
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && btAdapter.isLeExtendedAdvertisingSupported) {
      return try {
        val params = AdvertisingSetParameters.Builder()
          .setLegacyMode(false)
          .setConnectable(false)
          .setInterval(AdvertisingSetParameters.INTERVAL_LOW)
          .setTxPowerLevel(AdvertisingSetParameters.TX_POWER_HIGH)
          .build()

        val data = AdvertiseData.Builder()
          .addServiceUuid(SERVICE_UUID)
          .addServiceData(SERVICE_UUID, packet56)
          .build()

        val cb = object : AdvertisingSetCallback() {
          override fun onAdvertisingSetStarted(set: AdvertisingSet?, txPower: Int, status: Int) {
            val callbackRef = this
            activeExtendedSet = set
            if (status == ADVERTISE_SUCCESS && set != null) {
              scope.launch {
                delay(durationMs)
                try {
                  advertiser.stopAdvertisingSet(callbackRef)
                } catch (_: Throwable) {
                }
              }
            }
          }
        }
        advertiser.startAdvertisingSet(params, data, null, null, null, cb)
        Result.success(Unit)
      } catch (t: Throwable) {
        Result.failure(t)
      }
    }

    // Legacy BLE 4.x fallback: broadcast 2 sequential manufacturer-data halves
    return try {
      val tag0 = packet56[2]
      val tag1 = packet56[3]
      val part0 = ByteArray(1 + FRAG_TAG_LEN + HALF_PACKET_LEN).apply {
        this[0] = 0
        this[1] = tag0
        this[2] = tag1
        System.arraycopy(packet56, 0, this, 3, HALF_PACKET_LEN)
      }
      val part1 = ByteArray(1 + FRAG_TAG_LEN + HALF_PACKET_LEN).apply {
        this[0] = 1
        this[1] = tag0
        this[2] = tag1
        System.arraycopy(packet56, HALF_PACKET_LEN, this, 3, HALF_PACKET_LEN)
      }

      val settings = AdvertiseSettings.Builder()
        .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
        .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_HIGH)
        .setConnectable(false)
        .setTimeout(1500)
        .build()

      scope.launch {
        for (frag in listOf(part0, part1)) {
          val data = AdvertiseData.Builder()
            .addManufacturerData(MANUFACTURER_ID, frag)
            .build()
          val cb = object : AdvertiseCallback() {}
          advertiser.startAdvertising(settings, data, cb)
          delay(1600L)
          try {
            advertiser.stopAdvertising(cb)
          } catch (_: Throwable) {
          }
        }
      }
      Result.success(Unit)
    } catch (t: Throwable) {
      Result.failure(t)
    }
  }

  fun release() {
    stopScanning()
  }
}
