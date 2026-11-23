package com.aryakhaslana.sonarmesh.protocol

import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.MessageDigest
import java.util.LinkedHashMap

/**
 * Exact 56-byte Big-Endian SMPv1 binary protocol codec.
 *
 * Byte Layout (total = 56 bytes):
 *   0      : MAGIC_VER (0x51)
 *   1      : FLAGS_TTL ([7:6] triggerType, [5] envPocketBag, [4] sirenReq, [3:0] ttl)
 *   2..9   : PACKET_ID (8 bytes)
 *   10..11 : SEQ_COUNTER (uint16 BE)
 *   12..15 : LATITUDE (int32 BE, degrees * 1e7)
 *   16..19 : LONGITUDE (int32 BE, degrees * 1e7)
 *   20     : GPS_ACC_BATT ([7:4] gpsAccBucket 0..15, [3:0] batteryQuant 0..15)
 *   21..22 : AGE_SEC (uint16 BE)
 *   23..26 : SENDER_HINT (4 bytes)
 *   27..28 : POW_NONCE (uint16 BE)
 *   29..37 : SHORT_PAYLOAD (9 bytes UTF-8, zero-padded)
 *   38..53 : AUTH_SIG_128 (16 bytes lightweight MVP tag)
 *   54..55 : CRC16 CCITT-FALSE (poly 0x1021, init 0xFFFF) over bytes 0..53
 */
object SmpV1Codec {
  const val PACKET_SIZE = 56
  const val FRAME_HEADER_SIZE = 4
  const val FRAMED_SIZE = FRAME_HEADER_SIZE + PACKET_SIZE
  const val MAGIC_VER: Byte = 0x51

  val ACOUSTIC_PREAMBLE = byteArrayOf(
    0xAA.toByte(),
    0xAA.toByte(),
    0x2D.toByte(),
    0xD4.toByte(),
  )

  const val SYNC_WORD: Int = 0x2DD4

  enum class TriggerType(val code: Int) {
    MANUAL(0),
    SENSOR_SOS(1),
    DAILY_RADAR(2),
    WITNESS_PIN(3);

    companion object {
      fun fromCode(code: Int): TriggerType = entries.firstOrNull { it.code == (code and 0x03) } ?: MANUAL
    }
  }

  data class Packet(
    val triggerType: TriggerType,
    val envPocketBag: Boolean,
    val sirenReq: Boolean,
    val ttl: Int,
    val packetId: ByteArray,      // 8 bytes
    val seqCounter: Int,          // uint16
    val latitude: Double,
    val longitude: Double,
    val gpsAccBucket: Int,        // 0..15
    val batteryQuant: Int,        // 0..15
    val ageSec: Int,              // uint16
    val senderHint: ByteArray,    // 4 bytes
    val powNonce: Int,            // uint16
    val shortPayload: String,     // max 9 UTF-8 bytes
    val authSig128: ByteArray,    // 16 bytes
  ) {
    val packetIdHex: String
      get() = packetId.joinToString("") { "%02x".format(it) }

    val senderHintHex: String
      get() = senderHint.joinToString("") { "%02x".format(it) }
  }

  fun crc16CcittFalse(data: ByteArray, offset: Int = 0, length: Int = data.size - offset): Int {
    var crc = 0xFFFF
    for (i in offset until (offset + length)) {
      crc = crc xor ((data[i].toInt() and 0xFF) shl 8)
      repeat(8) {
        crc = if ((crc and 0x8000) != 0) {
          ((crc shl 1) xor 0x1021) and 0xFFFF
        } else {
          (crc shl 1) and 0xFFFF
        }
      }
    }
    return crc and 0xFFFF
  }

  /** Computes a lightweight deterministic 16-byte MVP tag over header+payload bytes 0..37. */
  fun computeMvpAuthTag(prefix38: ByteArray): ByteArray {
    val digest = MessageDigest.getInstance("SHA-256").digest(prefix38)
    return digest.copyOfRange(0, 16)
  }

  fun encode(pkt: Packet): ByteArray {
    require(pkt.packetId.size == 8) { "PACKET_ID must be 8 bytes" }
    require(pkt.senderHint.size == 4) { "SENDER_HINT must be 4 bytes" }

    val buf = ByteBuffer.allocate(PACKET_SIZE).order(ByteOrder.BIG_ENDIAN)

    // 0: MAGIC_VER
    buf.put(MAGIC_VER)

    // 1: FLAGS_TTL
    val flagsTtl = ((pkt.triggerType.code and 0x03) shl 6) or
      ((if (pkt.envPocketBag) 1 else 0) shl 5) or
      ((if (pkt.sirenReq) 1 else 0) shl 4) or
      (pkt.ttl.coerceIn(0, 15) and 0x0F)
    buf.put(flagsTtl.toByte())

    // 2..9: PACKET_ID
    buf.put(pkt.packetId)

    // 10..11: SEQ_COUNTER
    buf.putShort((pkt.seqCounter and 0xFFFF).toShort())

    // 12..15: LATITUDE (int32 * 1e7)
    val latInt = Math.round(pkt.latitude.coerceIn(-90.0, 90.0) * 1e7).toInt()
    buf.putInt(latInt)

    // 16..19: LONGITUDE (int32 * 1e7)
    val lonInt = Math.round(pkt.longitude.coerceIn(-180.0, 180.0) * 1e7).toInt()
    buf.putInt(lonInt)

    // 20: GPS_ACC_BATT
    val gpsAccBatt = ((pkt.gpsAccBucket.coerceIn(0, 15) and 0x0F) shl 4) or
      (pkt.batteryQuant.coerceIn(0, 15) and 0x0F)
    buf.put(gpsAccBatt.toByte())

    // 21..22: AGE_SEC
    buf.putShort((pkt.ageSec.coerceIn(0, 65535) and 0xFFFF).toShort())

    // 23..26: SENDER_HINT
    buf.put(pkt.senderHint)

    // 27..28: POW_NONCE
    buf.putShort((pkt.powNonce and 0xFFFF).toShort())

    // 29..37: SHORT_PAYLOAD (9 bytes zero-padded)
    val payloadBytes = ByteArray(9)
    val utf8 = pkt.shortPayload.toByteArray(Charsets.UTF_8)
    System.arraycopy(utf8, 0, payloadBytes, 0, minOf(utf8.size, 9))
    buf.put(payloadBytes)

    // 38..53: AUTH_SIG_128
    val sig = if (pkt.authSig128.size == 16 && pkt.authSig128.any { it != 0.toByte() }) {
      pkt.authSig128
    } else {
      computeMvpAuthTag(buf.array().copyOfRange(0, 38))
    }
    buf.put(sig)

    // 54..55: CRC16 over bytes 0..53
    val crc = crc16CcittFalse(buf.array(), 0, 54)
    buf.putShort(crc.toShort())

    return buf.array()
  }

  fun decode(raw: ByteArray): Result<Packet> {
    if (raw.size != PACKET_SIZE) {
      return Result.failure(IllegalArgumentException("Expected $PACKET_SIZE bytes, got ${raw.size}"))
    }
    if (raw[0] != MAGIC_VER) {
      return Result.failure(IllegalArgumentException("Invalid MAGIC_VER: 0x${"%02x".format(raw[0])}"))
    }

    val buf = ByteBuffer.wrap(raw).order(ByteOrder.BIG_ENDIAN)
    val expectedCrc = crc16CcittFalse(raw, 0, 54)
    val actualCrc = ((raw[54].toInt() and 0xFF) shl 8) or (raw[55].toInt() and 0xFF)
    if (expectedCrc != actualCrc) {
      return Result.failure(
        IllegalArgumentException("CRC16 mismatch: expected 0x${"%04x".format(expectedCrc)}, got 0x${"%04x".format(actualCrc)}")
      )
    }

    buf.get() // skip magic
    val flagsTtl = buf.get().toInt() and 0xFF
    val triggerType = TriggerType.fromCode((flagsTtl ushr 6) and 0x03)
    val envPocketBag = ((flagsTtl ushr 5) and 0x01) == 1
    val sirenReq = ((flagsTtl ushr 4) and 0x01) == 1
    val ttl = flagsTtl and 0x0F

    val packetId = ByteArray(8).also { buf.get(it) }
    val seqCounter = buf.short.toInt() and 0xFFFF
    val latitude = buf.int.toDouble() / 1e7
    val longitude = buf.int.toDouble() / 1e7

    val gpsAccBatt = buf.get().toInt() and 0xFF
    val gpsAccBucket = (gpsAccBatt ushr 4) and 0x0F
    val batteryQuant = gpsAccBatt and 0x0F

    val ageSec = buf.short.toInt() and 0xFFFF
    val senderHint = ByteArray(4).also { buf.get(it) }
    val powNonce = buf.short.toInt() and 0xFFFF

    val shortPayloadRaw = ByteArray(9).also { buf.get(it) }
    val endIdx = shortPayloadRaw.indexOfFirst { it == 0.toByte() }.let { if (it == -1) 9 else it }
    val shortPayload = String(shortPayloadRaw, 0, endIdx, Charsets.UTF_8)

    val authSig128 = ByteArray(16).also { buf.get(it) }

    return Result.success(
      Packet(
        triggerType = triggerType,
        envPocketBag = envPocketBag,
        sirenReq = sirenReq,
        ttl = ttl,
        packetId = packetId,
        seqCounter = seqCounter,
        latitude = latitude,
        longitude = longitude,
        gpsAccBucket = gpsAccBucket,
        batteryQuant = batteryQuant,
        ageSec = ageSec,
        senderHint = senderHint,
        powNonce = powNonce,
        shortPayload = shortPayload,
        authSig128 = authSig128,
      )
    )
  }

  /** Wraps a 56-byte SMPv1 packet with the 4-byte ultrasonic preamble + sync word. */
  fun frameForAcoustic(packet56: ByteArray): ByteArray {
    require(packet56.size == PACKET_SIZE)
    val framed = ByteArray(FRAMED_SIZE)
    System.arraycopy(ACOUSTIC_PREAMBLE, 0, framed, 0, FRAME_HEADER_SIZE)
    System.arraycopy(packet56, 0, framed, FRAME_HEADER_SIZE, PACKET_SIZE)
    return framed
  }

  /**
   * Produces a relayed copy with TTL decremented by 1 and AGE_SEC incremented.
   * Returns null when TTL <= 0 (packet must be kept locally and NOT relayed further).
   */
  fun prepareRelay(pkt: Packet, elapsedSec: Int): ByteArray? {
    if (pkt.ttl <= 0) return null
    val nextTtl = pkt.ttl - 1
    if (nextTtl <= 0) return null
    val relayed = pkt.copy(
      ttl = nextTtl,
      ageSec = (pkt.ageSec + elapsedSec.coerceAtLeast(1)).coerceAtMost(65535),
    )
    return encode(relayed)
  }
}

/**
 * Thread-safe bounded deduplication & replay filter keyed by PACKET_ID and per-sender SEQ_COUNTER.
 */
class PacketDeduplicator(
  private val maxEntries: Int = 512,
  private val windowMs: Long = 10 * 60 * 1000L,
) {
  private val seenPackets = object : LinkedHashMap<String, Long>(maxEntries, 0.75f, true) {
    override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Long>?): Boolean =
      size > maxEntries
  }
  private val highestSeqBySender = HashMap<String, Int>()

  @Synchronized
  fun acceptIfFresh(pkt: SmpV1Codec.Packet, nowMs: Long = System.currentTimeMillis()): Boolean {
    val id = pkt.packetIdHex
    val prevTime = seenPackets[id]
    if (prevTime != null && (nowMs - prevTime) < windowMs) {
      return false
    }

    val sender = pkt.senderHintHex
    val lastSeq = highestSeqBySender[sender]
    if (lastSeq != null && pkt.seqCounter < lastSeq && (lastSeq - pkt.seqCounter) < 32768) {
      return false
    }

    seenPackets[id] = nowMs
    if (lastSeq == null || pkt.seqCounter > lastSeq) {
      highestSeqBySender[sender] = pkt.seqCounter
    }
    return true
  }
}
