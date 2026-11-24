package com.aryakhaslana.sonarmesh.audio

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import androidx.core.content.ContextCompat
import com.aryakhaslana.sonarmesh.protocol.SmpV1Codec
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.sin
import kotlin.math.sqrt

data class UltrasonicConfig(
  val sampleRate: Int = 48000,
  val freqSpace0Hz: Double = 18750.0,
  val freqMark1Hz: Double = 19500.0,
  val symbolDurationMs: Int = 20,
  val fftSize: Int = 1024,
  val sirenFreqHz: Double = 3500.0,
) {
  val samplesPerSymbol: Int
    get() = (sampleRate * symbolDurationMs) / 1000
}

data class SpectrumFrame(
  val startFreqHz: Double,
  val endFreqHz: Double,
  val binsDb: List<Double>,
  val peakFreqHz: Double,
  val noiseFloorDb: Double,
  val snrDb: Double,
)

/**
 * Near-ultrasonic FSK acoustic modem (18.5-20 kHz) + 3.5 kHz rescue siren engine.
 * - TX uses AudioTrack at 48 kHz and temporarily raises STREAM_MUSIC volume to max.
 * - RX uses on-demand AudioRecord at 48 kHz + Radix-2 FFT + 3s noise-floor calibration + 0x2DD4 sync lock.
 */
class UltrasonicModem(
  private val context: Context,
  @Volatile var config: UltrasonicConfig = UltrasonicConfig(),
) {
  @Volatile private var onAsyncError: ((String) -> Unit)? = null
  private val errorHandler = CoroutineExceptionHandler { _, throwable ->
    onAsyncError?.invoke(throwable.message ?: "Acoustic modem coroutine error")
  }
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default + errorHandler)

  @Volatile private var rxJob: Job? = null
  @Volatile private var sirenJob: Job? = null
  @Volatile private var noiseFloorMag: Double = 0.0025
  @Volatile private var thresholdMag: Double = 0.0075
  @Volatile private var noiseFloorDb: Double = -52.0

  @Volatile private var calibrating = false
  private val calibrationLock = Any()
  private val calibrationSamples = mutableListOf<Double>()
  @Volatile private var calibrationEndMs = 0L
  @Volatile private var onCalibrationDone: ((Double, Double) -> Unit)? = null

  fun isListening(): Boolean = rxJob?.isActive == true
  fun isSirenPlaying(): Boolean = sirenJob?.isActive == true

  /**
   * Modulates 4-byte framing header (0xAA 0xAA 0x2D 0xD4) + 56-byte SMPv1 payload into
   * 18.5-20 kHz FSK audio and transmits through AudioTrack at maximum media volume.
   */
  fun transmitPacket(packet56: ByteArray): Result<Int> {
    if (packet56.size != SmpV1Codec.PACKET_SIZE) {
      return Result.failure(IllegalArgumentException("Packet must be exactly 56 bytes"))
    }

    val framed = SmpV1Codec.frameForAcoustic(packet56)
    val cfg = config
    val pcm = synthesizeFskPcm(framed, cfg)

    val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
    val prevVolume = try {
      audioManager?.getStreamVolume(AudioManager.STREAM_MUSIC) ?: -1
    } catch (_: Throwable) {
      -1
    }
    val maxVolume = try {
      audioManager?.getStreamMaxVolume(AudioManager.STREAM_MUSIC) ?: -1
    } catch (_: Throwable) {
      -1
    }

    var track: AudioTrack? = null
    return try {
      if (audioManager != null && maxVolume > 0) {
        try {
          audioManager.setStreamVolume(AudioManager.STREAM_MUSIC, maxVolume, 0)
        } catch (_: Throwable) {
          // DND SecurityException or OEM volume restriction: continue at current volume.
        }
      }

      val byteLen = pcm.size * 2
      track = AudioTrack.Builder()
        .setAudioAttributes(
          AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_MEDIA)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build()
        )
        .setAudioFormat(
          AudioFormat.Builder()
            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
            .setSampleRate(cfg.sampleRate)
            .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
            .build()
        )
        .setBufferSizeInBytes(byteLen)
        .setTransferMode(AudioTrack.MODE_STATIC)
        .build()

      track.write(pcm, 0, pcm.size)
      track.play()

      val durationMs = ((pcm.size.toDouble() / cfg.sampleRate) * 1000.0).toLong() + 120L
      Thread.sleep(durationMs)
      track.stop()
      Result.success(durationMs.toInt())
    } catch (t: Throwable) {
      Result.failure(t)
    } finally {
      try {
        track?.release()
      } catch (_: Throwable) {
      }
      if (audioManager != null && prevVolume >= 0) {
        try {
          audioManager.setStreamVolume(AudioManager.STREAM_MUSIC, prevVolume, 0)
        } catch (_: Throwable) {
        }
      }
    }
  }

  /** Synthesizes continuous-phase FSK PCM16 audio with soft edge tapering to avoid audible clicks. */
  fun synthesizeFskPcm(framedBytes: ByteArray, cfg: UltrasonicConfig): ShortArray {
    val sps = cfg.samplesPerSymbol
    val totalBits = framedBytes.size * 8
    val pcm = ShortArray(totalBits * sps)
    val ramp = (cfg.sampleRate * 2) / 1000 // 2ms raised-cosine edge taper
    var phase = 0.0
    var outIdx = 0

    for (b in framedBytes) {
      val unsigned = b.toInt() and 0xFF
      for (bitIdx in 7 downTo 0) {
        val bit = (unsigned ushr bitIdx) and 1
        val freq = if (bit == 1) cfg.freqMark1Hz else cfg.freqSpace0Hz
        val phaseInc = (2.0 * PI * freq) / cfg.sampleRate

        for (s in 0 until sps) {
          var env = 1.0
          if (s < ramp) {
            env = 0.5 * (1.0 - cos((PI * s) / ramp))
          } else if (s > sps - ramp) {
            env = 0.5 * (1.0 - cos((PI * (sps - s)) / ramp))
          }
          pcm[outIdx++] = (sin(phase) * env * 30000.0).toInt().coerceIn(-32767, 32767).toShort()
          phase += phaseInc
          if (phase > 2.0 * PI) phase -= 2.0 * PI
        }
      }
    }
    return pcm
  }

  /** Runs a 3-second ambient noise-floor calibration while the receiver is listening. */
  fun triggerNoiseCalibration(durationMs: Long = 3000L, onComplete: (Double, Double) -> Unit) {
    synchronized(calibrationLock) {
      calibrationSamples.clear()
      calibrationEndMs = System.currentTimeMillis() + durationMs
      onCalibrationDone = onComplete
      calibrating = true
    }
  }

  @SuppressLint("MissingPermission")
  fun startListening(
    onSpectrum: (SpectrumFrame) -> Unit,
    onPacketDecoded: (ByteArray, Double) -> Unit,
    onError: (String) -> Unit,
  ) {
    onAsyncError = onError
    if (rxJob?.isActive == true) return
    if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
      onError("RECORD_AUDIO permission not granted")
      return
    }

    val cfg = config
    val minBuf = try {
      AudioRecord.getMinBufferSize(
        cfg.sampleRate,
        AudioFormat.CHANNEL_IN_MONO,
        AudioFormat.ENCODING_PCM_16BIT,
      )
    } catch (t: Throwable) {
      onError(t.message ?: "AudioRecord unavailable")
      return
    }
    if (minBuf <= 0) {
      onError("AudioRecord not supported at ${cfg.sampleRate} Hz")
      return
    }

    rxJob = scope.launch {
      var recorder: AudioRecord? = null
      try {
        recorder = AudioRecord(
          MediaRecorder.AudioSource.UNPROCESSED,
          cfg.sampleRate,
          AudioFormat.CHANNEL_IN_MONO,
          AudioFormat.ENCODING_PCM_16BIT,
          max(minBuf * 2, cfg.fftSize * 4),
        )
        if (recorder.state != AudioRecord.STATE_INITIALIZED) {
          recorder.release()
          recorder = AudioRecord(
            MediaRecorder.AudioSource.MIC,
            cfg.sampleRate,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
            max(minBuf * 2, cfg.fftSize * 4),
          )
        }
        if (recorder.state != AudioRecord.STATE_INITIALIZED) {
          onError("Failed to initialize AudioRecord microphone capture")
          return@launch
        }

        val fft = Radix2FFT(cfg.fftSize)
        val hopSamples = cfg.samplesPerSymbol
        val ring = ShortArray(cfg.fftSize)
        val readBuf = ShortArray(hopSamples)

        val binStart = Radix2FFT.freqToBin(18200.0, cfg.sampleRate, cfg.fftSize)
        val binEnd = Radix2FFT.freqToBin(20200.0, cfg.sampleRate, cfg.fftSize)
        val binSpace = Radix2FFT.freqToBin(cfg.freqSpace0Hz, cfg.sampleRate, cfg.fftSize)
        val binMark = Radix2FFT.freqToBin(cfg.freqMark1Hz, cfg.sampleRate, cfg.fftSize)

        var syncShiftReg = 0
        var synced = false
        val payloadBits = BooleanArray(SmpV1Codec.PACKET_SIZE * 8)
        var bitCount = 0
        var lastSpectrumEmitMs = 0L

        recorder.startRecording()

        while (isActive) {
          val read = recorder.read(readBuf, 0, hopSamples)
          if (read <= 0) continue

          // Slide ring buffer forward by hopSamples (1 symbol window)
          val keep = cfg.fftSize - read
          if (keep > 0) {
            System.arraycopy(ring, read, ring, 0, keep)
          }
          System.arraycopy(readBuf, 0, ring, max(0, keep), minOf(read, cfg.fftSize))

          val mags = fft.computeMagnitudes(ring)
          val spaceEnergy = bandPeak(mags, binSpace, 1)
          val markEnergy = bandPeak(mags, binMark, 1)
          val activeEnergy = max(spaceEnergy, markEnergy)

          if (calibrating) {
            var completedCallback: ((Double, Double) -> Unit)? = null
            var completedFloorDb = noiseFloorDb
            var completedThresholdDb = noiseFloorDb
            synchronized(calibrationLock) {
              if (calibrating) {
                calibrationSamples.add(activeEnergy)
                if (System.currentTimeMillis() >= calibrationEndMs) {
                  calibrating = false
                  val snapshot = calibrationSamples.toList()
                  calibrationSamples.clear()
                  val mean = if (snapshot.isEmpty()) 0.002 else snapshot.average()
                  val variance = if (snapshot.isEmpty()) 0.0 else snapshot.map { (it - mean) * (it - mean) }.average()
                  val stdDev = sqrt(variance)
                  noiseFloorMag = max(mean, 1e-5)
                  thresholdMag = max(mean + 3.5 * stdDev, mean * 2.2)
                  noiseFloorDb = Radix2FFT.magnitudeToDb(noiseFloorMag)
                  completedFloorDb = noiseFloorDb
                  completedThresholdDb = Radix2FFT.magnitudeToDb(thresholdMag)
                  completedCallback = onCalibrationDone
                  onCalibrationDone = null
                }
              }
            }
            completedCallback?.invoke(completedFloorDb, completedThresholdDb)
          }

          val nowMs = System.currentTimeMillis()
          if (nowMs - lastSpectrumEmitMs >= 65L) {
            lastSpectrumEmitMs = nowMs
            val slice = ArrayList<Double>(binEnd - binStart + 1)
            var peakBin = binStart
            var peakMag = 0.0
            for (b in binStart..binEnd) {
              val m = mags[b]
              if (m > peakMag) {
                peakMag = m
                peakBin = b
              }
              slice.add(Radix2FFT.magnitudeToDb(m))
            }
            val peakFreq = (peakBin.toDouble() * cfg.sampleRate) / cfg.fftSize
            val snrDb = Radix2FFT.magnitudeToDb(peakMag) - noiseFloorDb
            onSpectrum(
              SpectrumFrame(
                startFreqHz = (binStart.toDouble() * cfg.sampleRate) / cfg.fftSize,
                endFreqHz = (binEnd.toDouble() * cfg.sampleRate) / cfg.fftSize,
                binsDb = slice,
                peakFreqHz = peakFreq,
                noiseFloorDb = noiseFloorDb,
                snrDb = snrDb,
              )
            )
          }

          // FSK bit demodulation + 0x2DD4 sync lock
          if (activeEnergy >= thresholdMag) {
            val bit = if (markEnergy >= spaceEnergy) 1 else 0
            if (!synced) {
              syncShiftReg = ((syncShiftReg shl 1) or bit) and 0xFFFF
              if (syncShiftReg == SmpV1Codec.SYNC_WORD) {
                synced = true
                bitCount = 0
              }
            } else {
              payloadBits[bitCount++] = (bit == 1)
              if (bitCount >= payloadBits.size) {
                val candidate = bitsToBytes(payloadBits)
                synced = false
                syncShiftReg = 0
                bitCount = 0
                if (SmpV1Codec.decode(candidate).isSuccess) {
                  val snrDb = Radix2FFT.magnitudeToDb(activeEnergy) - noiseFloorDb
                  onPacketDecoded(candidate, snrDb)
                }
              }
            }
          } else if (synced) {
            // Signal dropped mid-frame; reset lock cleanly.
            synced = false
            syncShiftReg = 0
            bitCount = 0
          }
        }
      } catch (t: Throwable) {
        onError(t.message ?: "Acoustic receiver error")
      } finally {
        try {
          recorder?.stop()
        } catch (_: Throwable) {
        }
        try {
          recorder?.release()
        } catch (_: Throwable) {
        }
      }
    }
  }

  fun stopListening() {
    rxJob?.cancel()
    rxJob = null
  }

  /** Plays a high-visibility 3.5 kHz pulsing rescue siren via AudioTrack until stopped. */
  fun startSiren() {
    if (sirenJob?.isActive == true) return
    val cfg = config
    val sampleRate = cfg.sampleRate
    val pulseOnSamples = (sampleRate * 500) / 1000
    val pulseOffSamples = (sampleRate * 200) / 1000
    val cycleSamples = pulseOnSamples + pulseOffSamples
    val cyclePcm = ShortArray(cycleSamples)

    var phase = 0.0
    for (i in 0 until pulseOnSamples) {
      val sweep = cfg.sirenFreqHz + 40.0 * sin((2.0 * PI * 6.0 * i) / sampleRate)
      phase += (2.0 * PI * sweep) / sampleRate
      cyclePcm[i] = (sin(phase) * 31000.0).toInt().toShort()
    }

    sirenJob = scope.launch {
      val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
      try {
        val maxVol = audioManager?.getStreamMaxVolume(AudioManager.STREAM_MUSIC) ?: -1
        if (audioManager != null && maxVol > 0) {
          audioManager.setStreamVolume(AudioManager.STREAM_MUSIC, maxVol, 0)
        }
      } catch (_: Throwable) {
        // DND SecurityException or OEM restriction: continue siren at current volume.
      }

      var track: AudioTrack? = null
      try {
        val minBuf = AudioTrack.getMinBufferSize(
          sampleRate,
          AudioFormat.CHANNEL_OUT_MONO,
          AudioFormat.ENCODING_PCM_16BIT,
        )
        track = AudioTrack.Builder()
          .setAudioAttributes(
            AudioAttributes.Builder()
              .setUsage(AudioAttributes.USAGE_ALARM)
              .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
              .build()
          )
          .setAudioFormat(
            AudioFormat.Builder()
              .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
              .setSampleRate(sampleRate)
              .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
              .build()
          )
          .setBufferSizeInBytes(max(minBuf * 2, cyclePcm.size * 2))
          .setTransferMode(AudioTrack.MODE_STREAM)
          .build()

        track.play()
        while (isActive) {
          track.write(cyclePcm, 0, cyclePcm.size)
        }
      } catch (t: Throwable) {
        onAsyncError?.invoke(t.message ?: "Rescue siren audio error")
      } finally {
        try {
          track?.stop()
        } catch (_: Throwable) {
        }
        try {
          track?.release()
        } catch (_: Throwable) {
        }
      }
    }
  }

  fun stopSiren() {
    sirenJob?.cancel()
    sirenJob = null
  }

  fun release() {
    stopListening()
    stopSiren()
    scope.cancel()
  }

  private fun bandPeak(mags: DoubleArray, centerBin: Int, radius: Int): Double {
    var best = 0.0
    for (b in max(0, centerBin - radius)..minOf(mags.lastIndex, centerBin + radius)) {
      if (mags[b] > best) best = mags[b]
    }
    return best
  }

  private fun bitsToBytes(bits: BooleanArray): ByteArray {
    val out = ByteArray(bits.size / 8)
    for (i in out.indices) {
      var v = 0
      for (b in 0 until 8) {
        v = (v shl 1) or if (bits[i * 8 + b]) 1 else 0
      }
      out[i] = v.toByte()
    }
    return out
  }
}
