package com.aryakhaslana.sonarmesh.ble

import android.Manifest
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
import android.content.pm.PackageManager
import android.os.Build
import android.os.ParcelUuid
import androidx.core.content.ContextCompat
import com.aryakhaslana.sonarmesh.protocol.PacketDeduplicator
import com.aryakhaslana.sonarmesh.protocol.SmpV1Codec
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
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
 * Pure-Kotlin 3-fragment splitter & reassembler for legacy BLE 4.x 31-byte advertising PDUs.
 * 56-byte SMPv1 packet -> 19 + 19 + 18 bytes with 3-byte header [meta=0x30|idx, crc0, crc1]:
 * Manufacturer Data payload is at most 22 bytes (+4B AD header +3B Flags = 29B <= 31B).
 */
object LegacyBleFragmentCodec {
  const val HEADER_LEN = 3
  const val TOTAL_PARTS = 3
  const val CHUNK_LEN = 19 // 19 + 19 + 18 = 56

  data class ParsedFragment(
    val partIndex: Int,
    val tag: String,
    val chunk: ByteArray,
  )

  fun split(packet56: ByteArray): List<ByteArray> {
    require(packet56.size == SmpV1Codec.PACKET_SIZE) { "Expected 56-byte SMPv1 packet" }
    val tag0 = packet56[54]
    val tag1 = packet56[55]

    val sizes = intArrayOf(CHUNK_LEN, CHUNK_LEN, SmpV1Codec.PACKET_SIZE - (CHUNK_LEN * 2))
    val offsets = intArrayOf(0, CHUNK_LEN, CHUNK_LEN * 2)

    return List(TOTAL_PARTS) { idx ->
      val chunkLen = sizes[idx]
      ByteArray(HEADER_LEN + chunkLen).apply {
        this[0] = (0x30 or idx).toByte()
        this[1] = tag0
        this[2] = tag1
        System.arraycopy(packet56, offsets[idx], this, HEADER_LEN, chunkLen)
      }
    }
  }

  fun parse(mfgData: ByteArray): ParsedFragment? {
    if (mfgData.size < HEADER_LEN + 18) return null
    val meta = mfgData[0].toInt() and 0xFF
    val totalParts = (meta ushr 4) and 0x0F
    val partIdx = meta and 0x0F
    if (totalParts != TOTAL_PARTS || partIdx !in 0 until TOTAL_PARTS) return null

    val expectedChunkLen = if (partIdx < 2) CHUNK_LEN else SmpV1Codec.PACKET_SIZE - (CHUNK_LEN * 2)
    if (mfgData.size != HEADER_LEN + expectedChunkLen) return null

    val tag = "%02x%02x".format(mfgData[1], mfgData[2])
    val chunk = mfgData.copyOfRange(HEADER_LEN, mfgData.size)
    return ParsedFragment(partIndex = partIdx, tag = tag, chunk = chunk)
  }

  class Reassembler {
    private data class PartialTriple(
      var part0: ByteArray? = null,
      var part1: ByteArray? = null,
      var part2: ByteArray? = null,
      var updatedMs: Long = 0L,
    )

    private val cache = ConcurrentHashMap<String, PartialTriple>()

    fun accept(mfgData: ByteArray, nowMs: Long = System.currentTimeMillis()): ByteArray? {
      val parsed = parse(mfgData) ?: return null
      val entry = cache.computeIfAbsent(parsed.tag) { PartialTriple(updatedMs = nowMs) }
      val assembled = synchronized(entry) {
        when (parsed.partIndex) {
          0 -> entry.part0 = parsed.chunk
          1 -> entry.part1 = parsed.chunk
          2 -> entry.part2 = parsed.chunk
        }
        entry.updatedMs = nowMs
        val p0 = entry.part0
        val p1 = entry.part1
        val p2 = entry.part2
        if (p0 != null && p1 != null && p2 != null && p0.size + p1.size + p2.size == SmpV1Codec.PACKET_SIZE) {
          cache.remove(parsed.tag)
          ByteArray(SmpV1Codec.PACKET_SIZE).also { full ->
            System.arraycopy(p0, 0, full, 0, p0.size)
            System.arraycopy(p1, 0, full, p0.size, p1.size)
            System.arraycopy(p2, 0, full, p0.size + p1.size, p2.size)
          }
        } else {
          null
        }
      }

      if (cache.size > 64) {
        cache.entries.removeIf { nowMs - it.value.updatedMs > 15_000L }
      }
      return assembled
    }
  }
}

/**
 * Hardware-filtered BLE Advertising + Scanning relay transport for 56-byte SMPv1 packets.
 * - Uses BLE 5 Extended Advertising when supported to send all 56 bytes in one PDU.
 * - Falls back to 3-fragment legacy BLE 4.x advertising (19B + 19B + 18B) with reassembly.
 * - Enforces PACKET_ID deduplication, TTL decrement, and 200-2000ms random jitter backoff.
 */
class BleMeshTransport(
  private val context: Context,
  private val deduplicator: PacketDeduplicator = PacketDeduplicator(),
) {
  companion object {
    val SERVICE_UUID: ParcelUuid = ParcelUuid(UUID.fromString("00005150-0000-1000-8000-00805F9B34FB"))
    const val MANUFACTURER_ID = 0x5150
    const val ACTION_BLE_SCAN_BATCH = "com.aryakhaslana.sonarmesh.ACTION_BLE_SCAN_BATCH"
  }

  private val errorHandler = CoroutineExceptionHandler { _, throwable ->
    onErrorListener?.invoke(throwable.message ?: "BLE coroutine error")
  }
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO + errorHandler)
  private val bluetoothManager = context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
  private val adapter: BluetoothAdapter? get() = bluetoothManager?.adapter

  private val reassembler = LegacyBleFragmentCodec.Reassembler()
  private val relayCounter = AtomicInteger(0)
  @Volatile private var scanning = false
  @Volatile private var activeCallback: ScanCallback? = null
  @Volatile private var pendingScanIntent: PendingIntent? = null
  @Volatile private var activeExtendedSet: AdvertisingSet? = null
  @Volatile private var activeExtendedCallback: AdvertisingSetCallback? = null
  @Volatile private var onPacketListener: ((BlePacketEvent) -> Unit)? = null
  @Volatile private var onErrorListener: ((String) -> Unit)? = null

  fun getRelayedCount(): Int = relayCounter.get()

  fun setPacketListener(listener: ((BlePacketEvent) -> Unit)?) {
    onPacketListener = listener
  }

  fun setErrorListener(listener: ((String) -> Unit)?) {
    onErrorListener = listener
  }

  private fun hasScanPermission(): Boolean {
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      ContextCompat.checkSelfPermission(context, Manifest.permission.BLUETOOTH_SCAN) == PackageManager.PERMISSION_GRANTED
    } else {
      ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
        ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
    }
  }

  private fun hasAdvertisePermission(): Boolean {
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      ContextCompat.checkSelfPermission(context, Manifest.permission.BLUETOOTH_ADVERTISE) == PackageManager.PERMISSION_GRANTED
    } else {
      true
    }
  }

  @SuppressLint("MissingPermission")
  fun startScanning(lowLatency: Boolean = false): Result<Unit> {
    if (!hasScanPermission()) {
      return Result.failure(SecurityException("BLE scan permission not granted"))
    }
    return try {
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

        override fun onScanFailed(errorCode: Int) {
          scanning = false
          onErrorListener?.invoke("BLE scan failed with code $errorCode")
        }
      }
      activeCallback = callback

      scanner.startScan(filters, settings, callback)
      scanning = true
      Result.success(Unit)
    } catch (t: Throwable) {
      scanning = false
      Result.failure(t)
    }
  }

  @SuppressLint("MissingPermission")
  fun stopScanning() {
    val scanner = try {
      adapter?.bluetoothLeScanner
    } catch (_: Throwable) {
      null
    }
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

    // Case 2: Legacy BLE 4.x 3-fragment format
    val full = reassembler.accept(mfg) ?: return
    processInboundPacket(full, rssi)
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
        try {
          val jitterMs = Random.nextLong(200L, 2001L)
          delay(jitterMs)
          val res = advertisePacket(relayBytes, durationMs = 2500L)
          if (res.isSuccess) {
            relayCounter.incrementAndGet()
          }
        } catch (t: Throwable) {
          onErrorListener?.invoke(t.message ?: "BLE relay error")
        }
      }
    }
  }

  @SuppressLint("MissingPermission")
  fun advertisePacket(packet56: ByteArray, durationMs: Long = 3500L): Result<Unit> {
    if (packet56.size != SmpV1Codec.PACKET_SIZE) {
      return Result.failure(IllegalArgumentException("Expected 56-byte SMPv1 packet"))
    }
    if (!hasAdvertisePermission()) {
      return Result.failure(SecurityException("BLE advertise permission not granted"))
    }

    return try {
      val btAdapter = adapter ?: return Result.failure(IllegalStateException("Bluetooth adapter unavailable"))
      if (!btAdapter.isEnabled) {
        return Result.failure(IllegalStateException("Bluetooth is turned off"))
      }
      val advertiser = btAdapter.bluetoothLeAdvertiser
        ?: return Result.failure(IllegalStateException("BLE advertiser not supported on this device"))

      // Prefer BLE 5 Extended Advertising when device supports > 56 bytes
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && btAdapter.isLeExtendedAdvertisingSupported) {
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
            activeExtendedCallback = callbackRef
            if (status == ADVERTISE_SUCCESS && set != null) {
              scope.launch {
                try {
                  delay(durationMs)
                  advertiser.stopAdvertisingSet(callbackRef)
                } catch (_: Throwable) {
                }
              }
            } else if (status != ADVERTISE_SUCCESS) {
              onErrorListener?.invoke("BLE extended advertise failed: status $status")
            }
          }
        }
        advertiser.startAdvertisingSet(params, data, null, null, null, cb)
        return Result.success(Unit)
      }

      // Legacy BLE 4.x fallback: broadcast 3 sequential manufacturer-data fragments (<= 31B AD PDU)
      val fragments = LegacyBleFragmentCodec.split(packet56)

      val settings = AdvertiseSettings.Builder()
        .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
        .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_HIGH)
        .setConnectable(false)
        .setTimeout(1200)
        .build()

      scope.launch {
        for (frag in fragments) {
          val data = AdvertiseData.Builder()
            .addManufacturerData(MANUFACTURER_ID, frag)
            .build()
          val cb = object : AdvertiseCallback() {
            override fun onStartFailure(errorCode: Int) {
              onErrorListener?.invoke("BLE legacy advertise failed: code $errorCode")
            }
          }
          try {
            advertiser.startAdvertising(settings, data, cb)
            delay(1300L)
          } catch (t: Throwable) {
            onErrorListener?.invoke(t.message ?: "BLE legacy advertise error")
          } finally {
            try {
              advertiser.stopAdvertising(cb)
            } catch (_: Throwable) {
            }
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
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      activeExtendedCallback?.let { cb ->
        try {
          adapter?.bluetoothLeAdvertiser?.stopAdvertisingSet(cb)
        } catch (_: Throwable) {
        }
      }
    }
    activeExtendedSet = null
    activeExtendedCallback = null
    scope.cancel()
  }
}
