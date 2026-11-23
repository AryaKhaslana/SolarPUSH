package com.aryakhaslana.sonarmesh

import com.aryakhaslana.sonarmesh.audio.Radix2FFT
import com.aryakhaslana.sonarmesh.protocol.PacketDeduplicator
import com.aryakhaslana.sonarmesh.protocol.SmpV1Codec
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.PI
import kotlin.math.sin

class SmpV1CodecTest {
  private fun samplePacket(ttl: Int = 4, seq: Int = 12): SmpV1Codec.Packet = SmpV1Codec.Packet(
    triggerType = SmpV1Codec.TriggerType.SENSOR_SOS,
    envPocketBag = true,
    sirenReq = true,
    ttl = ttl,
    packetId = byteArrayOf(0x01, 0x23, 0x45, 0x67, 0x89.toByte(), 0xAB.toByte(), 0xCD.toByte(), 0xEF.toByte()),
    seqCounter = seq,
    latitude = -7.257472,
    longitude = 112.752088,
    gpsAccBucket = 2,
    batteryQuant = 11,
    ageSec = 42,
    senderHint = byteArrayOf(0xDE.toByte(), 0xAD.toByte(), 0xBE.toByte(), 0xEF.toByte()),
    powNonce = 77,
    shortPayload = "TRAPPED!",
    authSig128 = ByteArray(16),
  )

  @Test
  fun encodeDecodeExact56BytesBigEndian() {
    val raw = SmpV1Codec.encode(samplePacket())
    assertEquals(56, raw.size)
    assertEquals(0x51.toByte(), raw[0])

    val decoded = SmpV1Codec.decode(raw).getOrThrow()
    assertEquals(SmpV1Codec.TriggerType.SENSOR_SOS, decoded.triggerType)
    assertTrue(decoded.envPocketBag)
    assertTrue(decoded.sirenReq)
    assertEquals(4, decoded.ttl)
    assertEquals(12, decoded.seqCounter)
    assertEquals(-7.257472, decoded.latitude, 1e-6)
    assertEquals(112.752088, decoded.longitude, 1e-6)
    assertEquals(2, decoded.gpsAccBucket)
    assertEquals(11, decoded.batteryQuant)
    assertEquals(42, decoded.ageSec)
    assertEquals("TRAPPED!", decoded.shortPayload)
    assertEquals(77, decoded.powNonce)
  }

  @Test
  fun rejectsBadMagicAndCrcBitFlip() {
    val raw = SmpV1Codec.encode(samplePacket())

    val badMagic = raw.copyOf().also { it[0] = 0x52 }
    assertTrue(SmpV1Codec.decode(badMagic).isFailure)

    val bitFlip = raw.copyOf().also { it[15] = (it[15].toInt() xor 0x01).toByte() }
    assertTrue(SmpV1Codec.decode(bitFlip).isFailure)
  }

  @Test
  fun deduplicatorAndRelayTtlGuard() {
    val dedup = PacketDeduplicator()
    val pkt = samplePacket(ttl = 2, seq = 5)
    assertTrue(dedup.acceptIfFresh(pkt, nowMs = 1000L))
    assertFalse(dedup.acceptIfFresh(pkt, nowMs = 2000L))

    val relayedRaw = SmpV1Codec.prepareRelay(pkt, elapsedSec = 3)
    assertNotNull(relayedRaw)
    val relayed = SmpV1Codec.decode(relayedRaw!!).getOrThrow()
    assertEquals(1, relayed.ttl)
    assertEquals(45, relayed.ageSec)

    val exhausted = SmpV1Codec.prepareRelay(relayed, elapsedSec = 2)
    assertNull(exhausted)
  }

  @Test
  fun acousticFramingAndFftPeakDetection() {
    val raw = SmpV1Codec.encode(samplePacket())
    val framed = SmpV1Codec.frameForAcoustic(raw)
    assertEquals(60, framed.size)
    assertArrayEquals(SmpV1Codec.ACOUSTIC_PREAMBLE, framed.copyOfRange(0, 4))

    // Generate pure 19500 Hz tone at 48 kHz and confirm FFT peak lands on 19500 Hz bin
    val sampleRate = 48000
    val fftSize = 1024
    val pcm = ShortArray(fftSize) { i ->
      (sin(2.0 * PI * 19500.0 * i / sampleRate) * 28000.0).toInt().toShort()
    }
    val mags = Radix2FFT(fftSize).computeMagnitudes(pcm)
    val expectedBin = Radix2FFT.freqToBin(19500.0, sampleRate, fftSize)
    var maxBin = 0
    for (i in mags.indices) {
      if (mags[i] > mags[maxBin]) maxBin = i
    }
    assertTrue(kotlin.math.abs(maxBin - expectedBin) <= 1)
  }
}
