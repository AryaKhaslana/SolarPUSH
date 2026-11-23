package com.aryakhaslana.sonarmesh.audio

import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.ln
import kotlin.math.max
import kotlin.math.sin

/**
 * Pure Kotlin Cooley-Tukey Radix-2 FFT for real-time 48 kHz ultrasonic bin detection.
 */
class Radix2FFT(val size: Int) {
  init {
    require(size > 0 && (size and (size - 1)) == 0) { "FFT size must be power of 2" }
  }

  private val hannWindow = DoubleArray(size) { i ->
    0.5 * (1.0 - cos((2.0 * PI * i) / (size - 1)))
  }

  private val bitRev = IntArray(size).apply {
    val bits = Integer.numberOfTrailingZeros(size)
    for (i in 0 until size) {
      var x = i
      var r = 0
      repeat(bits) {
        r = (r shl 1) or (x and 1)
        x = x ushr 1
      }
      this[i] = r
    }
  }

  private val real = DoubleArray(size)
  private val imag = DoubleArray(size)

  /** Computes single-sided magnitude spectrum (length = size / 2 + 1) from PCM16 samples. */
  fun computeMagnitudes(pcm: ShortArray, offset: Int = 0): DoubleArray {
    for (i in 0 until size) {
      val sample = if (offset + i < pcm.size) pcm[offset + i].toDouble() / 32768.0 else 0.0
      val rev = bitRev[i]
      real[rev] = sample * hannWindow[i]
      imag[rev] = 0.0
    }

    var len = 2
    while (len <= size) {
      val halfLen = len ushr 1
      val angStep = -2.0 * PI / len
      val wLenReal = cos(angStep)
      val wLenImag = sin(angStep)

      var i = 0
      while (i < size) {
        var wReal = 1.0
        var wImag = 0.0
        for (j in 0 until halfLen) {
          val uReal = real[i + j]
          val uImag = imag[i + j]
          val vReal = real[i + j + halfLen] * wReal - imag[i + j + halfLen] * wImag
          val vImag = real[i + j + halfLen] * wImag + imag[i + j + halfLen] * wReal

          real[i + j] = uReal + vReal
          imag[i + j] = uImag + vImag
          real[i + j + halfLen] = uReal - vReal
          imag[i + j + halfLen] = uImag - vImag

          val nextWReal = wReal * wLenReal - wImag * wLenImag
          wImag = wReal * wLenImag + wImag * wLenReal
          wReal = nextWReal
        }
        i += len
      }
      len = len shl 1
    }

    val half = size / 2
    val mags = DoubleArray(half + 1)
    val norm = 2.0 / size
    for (k in 0..half) {
      mags[k] = hypot(real[k], imag[k]) * norm
    }
    return mags
  }

  companion object {
    fun freqToBin(freqHz: Double, sampleRate: Int, fftSize: Int): Int =
      Math.round((freqHz * fftSize) / sampleRate).toInt().coerceIn(0, fftSize / 2)

    fun magnitudeToDb(mag: Double): Double = 20.0 * ln(max(mag, 1e-7)) / ln(10.0)
  }
}
