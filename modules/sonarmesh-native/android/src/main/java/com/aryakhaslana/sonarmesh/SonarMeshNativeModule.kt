package com.aryakhaslana.sonarmesh

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.Uri
import android.os.BatteryManager
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import android.util.Base64
import androidx.core.content.ContextCompat
import com.aryakhaslana.sonarmesh.audio.UltrasonicConfig
import com.aryakhaslana.sonarmesh.audio.UltrasonicModem
import com.aryakhaslana.sonarmesh.ble.BleMeshTransport
import com.aryakhaslana.sonarmesh.ble.SonarMeshForegroundService
import com.aryakhaslana.sonarmesh.sensors.SensorConfig
import com.aryakhaslana.sonarmesh.sensors.SensorTriggerManager
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Expo Local Native Module bridging Kotlin Ultrasonic FSK Modem, BLE Relay ForegroundService,
 * 3.5 kHz Rescue Siren, and Hardware Sensors to the SonarMesh React Native UI.
 */
class SonarMeshNativeModule : Module() {
  private var modem: UltrasonicModem? = null
  private var ble: BleMeshTransport? = null
  private var sensors: SensorTriggerManager? = null

  private val ctx: Context
    get() = requireNotNull(appContext.reactContext) { "React context unavailable" }

  private fun ensureComponents() {
    if (modem == null) modem = UltrasonicModem(ctx)
    if (ble == null) {
      ble = BleMeshTransport(ctx).also { transport ->
        SonarMeshForegroundService.activeTransport = transport
        transport.setPacketListener { ev ->
          sendEvent(
            "onPacketReceived",
            mapOf(
              "packetBase64" to Base64.encodeToString(ev.rawBytes, Base64.NO_WRAP),
              "transport" to "ble",
              "rssi" to ev.rssi,
              "relayed" to ev.relayed,
              "snrDb" to 0.0,
            ),
          )
        }
      }
    }
    if (sensors == null) sensors = SensorTriggerManager(ctx)
  }

  override fun definition() = ModuleDefinition {
    Name("SonarMeshNative")

    Events(
      "onPacketReceived",
      "onSpectrumFrame",
      "onCalibrationResult",
      "onImpactDetected",
      "onSensorTelemetry",
      "onServiceStateChanged",
      "onNativeError",
    )

    AsyncFunction("startMeshService") { mode: String, lowLatency: Boolean ->
      ensureComponents()
      val intent = Intent(ctx, SonarMeshForegroundService::class.java).apply {
        action = SonarMeshForegroundService.ACTION_START
        putExtra(SonarMeshForegroundService.EXTRA_MODE, mode)
        putExtra(SonarMeshForegroundService.EXTRA_WITH_MIC, false)
      }
      ContextCompat.startForegroundService(ctx, intent)

      ble?.startScanning(lowLatency)?.onFailure {
        sendEvent("onNativeError", mapOf("source" to "ble", "message" to (it.message ?: "BLE scan error")))
      }

      sensors?.start(
        onImpactDetected = { mag, isPocket ->
          sendEvent(
            "onImpactDetected",
            mapOf("magnitudeMs2" to mag.toDouble(), "isPocketBag" to isPocket),
          )
        },
        onSensorTelemetry = { snap ->
          sendEvent(
            "onSensorTelemetry",
            mapOf(
              "accelMagnitudeMs2" to snap.accelMagnitudeMs2.toDouble(),
              "lightLux" to snap.lightLux.toDouble(),
              "isPocketBag" to snap.isPocketBag,
              "headingDeg" to snap.headingDeg.toDouble(),
            ),
          )
        },
      )

      sendEvent("onServiceStateChanged", mapOf("running" to true, "mode" to mode))
      mapOf("running" to true, "mode" to mode)
    }

    AsyncFunction("stopMeshService") {
      modem?.stopListening()
      modem?.stopSiren()
      ble?.stopScanning()
      sensors?.stop()

      val intent = Intent(ctx, SonarMeshForegroundService::class.java).apply {
        action = SonarMeshForegroundService.ACTION_STOP
      }
      ctx.startService(intent)

      sendEvent("onServiceStateChanged", mapOf("running" to false, "mode" to "IDLE"))
      mapOf("running" to false)
    }

    AsyncFunction("startAcousticListen") { freqSpace0Hz: Double, freqMark1Hz: Double, symbolMs: Int ->
      ensureComponents()
      val m = modem!!
      m.config = m.config.copy(
        freqSpace0Hz = freqSpace0Hz,
        freqMark1Hz = freqMark1Hz,
        symbolDurationMs = symbolMs,
      )
      // Update foreground service to include microphone while actively listening (FR-6 on-demand)
      val intent = Intent(ctx, SonarMeshForegroundService::class.java).apply {
        action = SonarMeshForegroundService.ACTION_START
        putExtra(SonarMeshForegroundService.EXTRA_MODE, "RADAR")
        putExtra(SonarMeshForegroundService.EXTRA_WITH_MIC, true)
      }
      ContextCompat.startForegroundService(ctx, intent)

      m.startListening(
        onSpectrum = { frame ->
          sendEvent(
            "onSpectrumFrame",
            mapOf(
              "startFreqHz" to frame.startFreqHz,
              "endFreqHz" to frame.endFreqHz,
              "binsDb" to frame.binsDb,
              "peakFreqHz" to frame.peakFreqHz,
              "noiseFloorDb" to frame.noiseFloorDb,
              "snrDb" to frame.snrDb,
            ),
          )
        },
        onPacketDecoded = { raw56, snrDb ->
          sendEvent(
            "onPacketReceived",
            mapOf(
              "packetBase64" to Base64.encodeToString(raw56, Base64.NO_WRAP),
              "transport" to "ultrasonic",
              "rssi" to -55,
              "relayed" to false,
              "snrDb" to snrDb,
            ),
          )
        },
        onError = { msg ->
          sendEvent("onNativeError", mapOf("source" to "audio", "message" to msg))
        },
      )
      mapOf("listening" to true)
    }

    AsyncFunction("stopAcousticListen") {
      modem?.stopListening()
      mapOf("listening" to false)
    }

    AsyncFunction("calibrateNoiseFloor") { durationMs: Int ->
      ensureComponents()
      modem?.triggerNoiseCalibration(durationMs.toLong()) { floorDb, threshDb ->
        sendEvent(
          "onCalibrationResult",
          mapOf("noiseFloorDb" to floorDb, "thresholdDb" to threshDb),
        )
      }
      mapOf("started" to true, "durationMs" to durationMs)
    }

    AsyncFunction("transmitUltrasonic") { packetBase64: String ->
      ensureComponents()
      val raw = Base64.decode(packetBase64, Base64.DEFAULT)
      val res = modem!!.transmitPacket(raw)
      if (res.isFailure) {
        throw IllegalStateException(res.exceptionOrNull()?.message ?: "Ultrasonic transmit failed")
      }
      mapOf("transmitted" to true, "durationMs" to res.getOrDefault(0))
    }

    AsyncFunction("broadcastBlePacket") { packetBase64: String, durationMs: Int ->
      ensureComponents()
      val raw = Base64.decode(packetBase64, Base64.DEFAULT)
      val res = ble!!.advertisePacket(raw, durationMs.toLong())
      if (res.isFailure) {
        throw IllegalStateException(res.exceptionOrNull()?.message ?: "BLE broadcast failed")
      }
      mapOf("broadcasting" to true)
    }

    AsyncFunction("startSiren") {
      ensureComponents()
      modem?.startSiren()
      mapOf("playing" to true)
    }

    AsyncFunction("stopSiren") {
      modem?.stopSiren()
      mapOf("playing" to false)
    }

    AsyncFunction("updateSensorConfig") { impactMs2: Double, pocketLux: Double ->
      ensureComponents()
      sensors?.config = SensorConfig(
        impactThresholdMs2 = impactMs2.toFloat(),
        pocketLuxThreshold = pocketLux.toFloat(),
      )
      mapOf("updated" to true)
    }

    AsyncFunction("requestIgnoreBatteryOptimizations") {
      val pm = ctx.getSystemService(Context.POWER_SERVICE) as? PowerManager
      val pkg = ctx.packageName
      val ignoring = pm?.isIgnoringBatteryOptimizations(pkg) == true
      if (!ignoring && Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
        val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
          data = Uri.parse("package:$pkg")
          addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        ctx.startActivity(intent)
      }
      mapOf("ignoring" to ignoring)
    }

    AsyncFunction("getDeviceTelemetry") {
      ensureComponents()
      val batIntent = ctx.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
      val level = batIntent?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
      val scale = batIntent?.getIntExtra(BatteryManager.EXTRA_SCALE, 100) ?: 100
      val batteryPct = if (level >= 0 && scale > 0) (level * 100) / scale else 100

      val airplaneMode = Settings.Global.getInt(
        ctx.contentResolver,
        Settings.Global.AIRPLANE_MODE_ON,
        0,
      ) != 0

      val snap = sensors?.currentSnapshot()
      mapOf(
        "batteryPct" to batteryPct,
        "airplaneMode" to airplaneMode,
        "serviceRunning" to SonarMeshForegroundService.isRunning,
        "relayedCount" to (ble?.getRelayedCount() ?: 0),
        "acousticListening" to (modem?.isListening() ?: false),
        "sirenPlaying" to (modem?.isSirenPlaying() ?: false),
        "accelMagnitudeMs2" to (snap?.accelMagnitudeMs2?.toDouble() ?: 9.81),
        "lightLux" to (snap?.lightLux?.toDouble() ?: 120.0),
        "isPocketBag" to (snap?.isPocketBag ?: false),
        "headingDeg" to (snap?.headingDeg?.toDouble() ?: 0.0),
      )
    }

    OnDestroy {
      modem?.release()
      ble?.release()
      sensors?.stop()
    }
  }
}
