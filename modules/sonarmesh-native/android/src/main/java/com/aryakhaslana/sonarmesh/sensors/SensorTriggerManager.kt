package com.aryakhaslana.sonarmesh.sensors

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import kotlin.math.sqrt

data class SensorConfig(
  val impactThresholdMs2: Float = 28.0f, // ~2.85g shock spike
  val pocketLuxThreshold: Float = 5.0f,  // <= 5 lux treated as pocket/bag darkness
)

data class SensorSnapshot(
  val accelMagnitudeMs2: Float,
  val lightLux: Float,
  val isPocketBag: Boolean,
  val headingDeg: Float,
)

/**
 * Manages hardware Accelerometer (shock impact trigger), Light Sensor (pocket/bag ENV_STATE),
 * and Rotation Vector / Compass azimuth for the Relative Compass Radar.
 */
class SensorTriggerManager(
  context: Context,
  @Volatile var config: SensorConfig = SensorConfig(),
) : SensorEventListener {
  private val sensorManager = context.getSystemService(Context.SENSOR_SERVICE) as? SensorManager
  private val accelSensor = sensorManager?.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)
  private val lightSensor = sensorManager?.getDefaultSensor(Sensor.TYPE_LIGHT)
  private val rotationSensor = sensorManager?.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR)

  @Volatile private var running = false
  @Volatile private var accelMag = 9.81f
  @Volatile private var lightLux = 120f
  @Volatile private var isPocketBag = false
  @Volatile private var headingDeg = 0f
  @Volatile private var lastImpactEmitMs = 0L
  @Volatile private var lastTelemetryEmitMs = 0L

  private var onImpact: ((Float, Boolean) -> Unit)? = null
  private var onTelemetry: ((SensorSnapshot) -> Unit)? = null

  private val rotMatrix = FloatArray(9)
  private val orientation = FloatArray(3)

  fun start(
    onImpactDetected: (Float, Boolean) -> Unit,
    onSensorTelemetry: (SensorSnapshot) -> Unit,
  ) {
    if (running) return
    onImpact = onImpactDetected
    onTelemetry = onSensorTelemetry

    accelSensor?.let { sensorManager?.registerListener(this, it, SensorManager.SENSOR_DELAY_GAME) }
    lightSensor?.let { sensorManager?.registerListener(this, it, SensorManager.SENSOR_DELAY_NORMAL) }
    rotationSensor?.let { sensorManager?.registerListener(this, it, SensorManager.SENSOR_DELAY_UI) }
    running = true
  }

  fun stop() {
    if (!running) return
    sensorManager?.unregisterListener(this)
    running = false
  }

  fun currentSnapshot(): SensorSnapshot = SensorSnapshot(
    accelMagnitudeMs2 = accelMag,
    lightLux = lightLux,
    isPocketBag = isPocketBag,
    headingDeg = headingDeg,
  )

  override fun onSensorChanged(event: SensorEvent) {
    val now = System.currentTimeMillis()
    when (event.sensor.type) {
      Sensor.TYPE_ACCELEROMETER -> {
        val x = event.values[0]
        val y = event.values[1]
        val z = event.values[2]
        val mag = sqrt(x * x + y * y + z * z)
        accelMag = mag

        if (mag >= config.impactThresholdMs2 && (now - lastImpactEmitMs) > 5000L) {
          lastImpactEmitMs = now
          onImpact?.invoke(mag, isPocketBag)
        }
      }

      Sensor.TYPE_LIGHT -> {
        val lux = event.values[0]
        lightLux = lux
        isPocketBag = lux <= config.pocketLuxThreshold
      }

      Sensor.TYPE_ROTATION_VECTOR -> {
        SensorManager.getRotationMatrixFromVector(rotMatrix, event.values)
        SensorManager.getOrientation(rotMatrix, orientation)
        val rawDeg = Math.toDegrees(orientation[0].toDouble()).toFloat()
        val normalized = (rawDeg + 360f) % 360f
        // Smooth low-pass filter on compass angle
        headingDeg = normalized
      }
    }

    if (now - lastTelemetryEmitMs >= 100L) {
      lastTelemetryEmitMs = now
      onTelemetry?.invoke(currentSnapshot())
    }
  }

  override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {
    // No-op
  }
}
