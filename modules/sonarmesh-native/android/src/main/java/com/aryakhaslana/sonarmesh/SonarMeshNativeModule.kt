package com.aryakhaslana.sonarmesh

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.Uri
import android.os.BatteryManager
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import android.util.Base64
import androidx.core.content.ContextCompat
import com.aryakhaslana.sonarmesh.audio.UltrasonicModem
import com.aryakhaslana.sonarmesh.ble.BleMeshTransport
import com.aryakhaslana.sonarmesh.ble.SonarMeshForegroundService
import com.aryakhaslana.sonarmesh.sensors.SensorConfig
import com.aryakhaslana.sonarmesh.sensors.SensorTriggerManager
import expo.modules.kotlin.exception.CodedException
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

  private fun contextOrNull(): Context? = appContext.reactContext

  private fun hasBlePermissions(context: Context): Boolean {
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      ContextCompat.checkSelfPermission(context, Manifest.permission.BLUETOOTH_SCAN) == PackageManager.PERMISSION_GRANTED &&
        ContextCompat.checkSelfPermission(context, Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED &&
        ContextCompat.checkSelfPermission(context, Manifest.permission.BLUETOOTH_ADVERTISE) == PackageManager.PERMISSION_GRANTED
    } else {
      ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
        ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
    }
  }

  private fun hasFgsConnectedDevicePermission(context: Context): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true
    return ContextCompat.checkSelfPermission(context, Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED ||
      ContextCompat.checkSelfPermission(context, Manifest.permission.BLUETOOTH_SCAN) == PackageManager.PERMISSION_GRANTED ||
      ContextCompat.checkSelfPermission(context, Manifest.permission.BLUETOOTH_ADVERTISE) == PackageManager.PERMISSION_GRANTED
  }

  private fun hasRecordAudioPermission(context: Context): Boolean =
    ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

  private fun emitNativeError(source: String, code: String, message: String) {
    try {
      sendEvent("onNativeError", mapOf("source" to source, "code" to code, "message" to message))
    } catch (_: Throwable) {
    }
  }

  private fun ensureComponents(context: Context) {
    val appCtx = context.applicationContext ?: context
    if (modem == null) {
      modem = UltrasonicModem(appCtx)
    }
    if (ble == null) {
      ble = BleMeshTransport(appCtx).also { transport ->
        SonarMeshForegroundService.activeTransport = transport
        transport.setErrorListener { msg ->
          emitNativeError("ble", "BLE_ERROR", msg)
        }
        transport.setPacketListener { ev ->
          try {
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
          } catch (_: Throwable) {
          }
        }
      }
    }
    if (sensors == null) {
      sensors = SensorTriggerManager(appCtx)
    }

    SonarMeshForegroundService.onServiceErrorListener = { code, message ->
      emitNativeError("service", code, message)
    }
    SonarMeshForegroundService.onServiceStateListener = { running, mode ->
      try {
        sendEvent("onServiceStateChanged", mapOf("running" to running, "mode" to mode))
      } catch (_: Throwable) {
      }
    }
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
      val context = contextOrNull()
        ?: throw CodedException("ERR_CONTEXT", "React context unavailable", null)
      ensureComponents(context)

      if (!hasBlePermissions(context)) {
        emitNativeError(
          "permissions",
          "PERMISSION_DENIED",
          "Bluetooth and location permissions required for mesh service",
        )
        return@AsyncFunction mapOf("running" to false, "mode" to mode)
      }

      val intent = Intent(context, SonarMeshForegroundService::class.java).apply {
        action = SonarMeshForegroundService.ACTION_START
        putExtra(SonarMeshForegroundService.EXTRA_MODE, mode)
        putExtra(SonarMeshForegroundService.EXTRA_WITH_MIC, false)
      }

      try {
        ContextCompat.startForegroundService(context, intent)
      } catch (t: Throwable) {
        emitNativeError("service", "FGS_START_FAILED", t.message ?: "Failed to start mesh foreground service")
        return@AsyncFunction mapOf("running" to false, "mode" to mode)
      }

      ble?.startScanning(lowLatency)?.onFailure {
        emitNativeError("ble", "BLE_SCAN_ERROR", it.message ?: "BLE scan error")
      }

      try {
        sensors?.start(
          onImpactDetected = { mag, isPocket ->
            try {
              sendEvent(
                "onImpactDetected",
                mapOf("magnitudeMs2" to mag.toDouble(), "isPocketBag" to isPocket),
              )
            } catch (_: Throwable) {
            }
          },
          onSensorTelemetry = { snap ->
            try {
              sendEvent(
                "onSensorTelemetry",
                mapOf(
                  "accelMagnitudeMs2" to snap.accelMagnitudeMs2.toDouble(),
                  "lightLux" to snap.lightLux.toDouble(),
                  "isPocketBag" to snap.isPocketBag,
                  "headingDeg" to snap.headingDeg.toDouble(),
                ),
              )
            } catch (_: Throwable) {
            }
          },
        )
      } catch (t: Throwable) {
        emitNativeError("sensors", "SENSOR_START_FAILED", t.message ?: "Failed to start hardware sensors")
      }

      sendEvent("onServiceStateChanged", mapOf("running" to true, "mode" to mode))
      mapOf("running" to true, "mode" to mode)
    }

    AsyncFunction("stopMeshService") {
      try {
        modem?.stopListening()
      } catch (_: Throwable) {
      }
      try {
        modem?.stopSiren()
      } catch (_: Throwable) {
      }
      try {
        ble?.stopScanning()
      } catch (_: Throwable) {
      }
      try {
        sensors?.stop()
      } catch (_: Throwable) {
      }

      val context = contextOrNull()
      if (context != null) {
        try {
          context.stopService(Intent(context, SonarMeshForegroundService::class.java))
        } catch (_: Throwable) {
        }
      }

      try {
        sendEvent("onServiceStateChanged", mapOf("running" to false, "mode" to "IDLE"))
      } catch (_: Throwable) {
      }
      mapOf("running" to false)
    }

    AsyncFunction("startAcousticListen") { freqSpace0Hz: Double, freqMark1Hz: Double, symbolMs: Int ->
      val context = contextOrNull()
        ?: throw CodedException("ERR_CONTEXT", "React context unavailable", null)
      ensureComponents(context)

      if (!hasRecordAudioPermission(context)) {
        val msg = "RECORD_AUDIO permission not granted"
        emitNativeError("audio", "PERMISSION_DENIED", msg)
        throw CodedException("ERR_PERMISSION_DENIED", msg, null)
      }

      val m = modem ?: throw CodedException("ERR_MODEM_UNAVAILABLE", "Ultrasonic modem unavailable", null)
      m.config = m.config.copy(
        freqSpace0Hz = freqSpace0Hz,
        freqMark1Hz = freqMark1Hz,
        symbolDurationMs = symbolMs,
      )

      // Update foreground service to include microphone while actively listening (FR-6 on-demand)
      if (hasFgsConnectedDevicePermission(context)) {
        val intent = Intent(context, SonarMeshForegroundService::class.java).apply {
          action = SonarMeshForegroundService.ACTION_START
          putExtra(SonarMeshForegroundService.EXTRA_MODE, "RADAR")
          putExtra(SonarMeshForegroundService.EXTRA_WITH_MIC, true)
        }
        try {
          ContextCompat.startForegroundService(context, intent)
        } catch (t: Throwable) {
          emitNativeError("service", "FGS_MIC_UPDATE_FAILED", t.message ?: "Foreground service mic update failed")
        }
      }

      m.startListening(
        onSpectrum = { frame ->
          try {
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
          } catch (_: Throwable) {
          }
        },
        onPacketDecoded = { raw56, snrDb ->
          try {
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
          } catch (_: Throwable) {
          }
        },
        onError = { msg ->
          emitNativeError("audio", "AUDIO_RX_ERROR", msg)
        },
      )
      mapOf("listening" to true)
    }

    AsyncFunction("stopAcousticListen") {
      modem?.stopListening()
      mapOf("listening" to false)
    }

    AsyncFunction("calibrateNoiseFloor") { durationMs: Int ->
      val context = contextOrNull()
        ?: throw CodedException("ERR_CONTEXT", "React context unavailable", null)
      ensureComponents(context)
      modem?.triggerNoiseCalibration(durationMs.toLong()) { floorDb, threshDb ->
        try {
          sendEvent(
            "onCalibrationResult",
            mapOf("noiseFloorDb" to floorDb, "thresholdDb" to threshDb),
          )
        } catch (_: Throwable) {
        }
      }
      mapOf("started" to true, "durationMs" to durationMs)
    }

    AsyncFunction("transmitUltrasonic") { packetBase64: String ->
      val context = contextOrNull()
        ?: throw CodedException("ERR_CONTEXT", "React context unavailable", null)
      ensureComponents(context)
      val raw = try {
        Base64.decode(packetBase64, Base64.DEFAULT)
      } catch (e: IllegalArgumentException) {
        throw CodedException("ERR_INVALID_BASE64", "Invalid Base64 packet payload", e)
      }
      val m = modem ?: throw CodedException("ERR_MODEM_UNAVAILABLE", "Ultrasonic modem unavailable", null)
      val res = m.transmitPacket(raw)
      if (res.isFailure) {
        val err = res.exceptionOrNull()
        throw CodedException("ERR_ULTRASONIC_TX", err?.message ?: "Ultrasonic transmit failed", err)
      }
      mapOf("transmitted" to true, "durationMs" to res.getOrDefault(0))
    }

    AsyncFunction("broadcastBlePacket") { packetBase64: String, durationMs: Int ->
      val context = contextOrNull()
        ?: throw CodedException("ERR_CONTEXT", "React context unavailable", null)
      ensureComponents(context)
      val raw = try {
        Base64.decode(packetBase64, Base64.DEFAULT)
      } catch (e: IllegalArgumentException) {
        throw CodedException("ERR_INVALID_BASE64", "Invalid Base64 packet payload", e)
      }
      val b = ble ?: throw CodedException("ERR_BLE_UNAVAILABLE", "BLE transport unavailable", null)
      val res = b.advertisePacket(raw, durationMs.toLong())
      if (res.isFailure) {
        val err = res.exceptionOrNull()
        throw CodedException("ERR_BLE_TX", err?.message ?: "BLE broadcast failed", err)
      }
      mapOf("broadcasting" to true)
    }

    AsyncFunction("startSiren") {
      val context = contextOrNull()
        ?: throw CodedException("ERR_CONTEXT", "React context unavailable", null)
      ensureComponents(context)
      modem?.startSiren()
      mapOf("playing" to true)
    }

    AsyncFunction("stopSiren") {
      modem?.stopSiren()
      mapOf("playing" to false)
    }

    AsyncFunction("updateSensorConfig") { impactMs2: Double, pocketLux: Double ->
      val context = contextOrNull()
        ?: throw CodedException("ERR_CONTEXT", "React context unavailable", null)
      ensureComponents(context)
      sensors?.config = SensorConfig(
        impactThresholdMs2 = impactMs2.toFloat(),
        pocketLuxThreshold = pocketLux.toFloat(),
      )
      mapOf("updated" to true)
    }

    AsyncFunction("isIgnoringBatteryOptimizations") {
      val context = contextOrNull() ?: return@AsyncFunction false
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
        return@AsyncFunction true
      }
      try {
        val pm = context.getSystemService(Context.POWER_SERVICE) as? PowerManager
        pm?.isIgnoringBatteryOptimizations(context.packageName) == true
      } catch (_: Throwable) {
        false
      }
    }

    AsyncFunction("requestIgnoreBatteryOptimizations") {
      val context = contextOrNull() ?: return@AsyncFunction mapOf("ignoring" to false)
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
        return@AsyncFunction mapOf("ignoring" to true)
      }
      val pkg = context.packageName
      val pm = try {
        context.getSystemService(Context.POWER_SERVICE) as? PowerManager
      } catch (_: Throwable) {
        null
      }
      val ignoring = try {
        pm?.isIgnoringBatteryOptimizations(pkg) == true
      } catch (_: Throwable) {
        false
      }
      if (!ignoring) {
        val candidates = listOf(
          Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
            data = Uri.parse("package:$pkg")
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
          },
          Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
          },
          Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
            data = Uri.parse("package:$pkg")
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
          },
        )
        var launched = false
        for (intent in candidates) {
          try {
            context.startActivity(intent)
            launched = true
            break
          } catch (_: Throwable) {
            // Try next fallback intent
          }
        }
        if (!launched) {
          emitNativeError("battery", "ACTIVITY_ERROR", "Unable to open battery optimization settings")
        }
      }
      mapOf("ignoring" to ignoring)
    }

    AsyncFunction("getDeviceTelemetry") {
      val context = contextOrNull()
      if (context == null) {
        return@AsyncFunction mapOf(
          "batteryPct" to 100,
          "airplaneMode" to false,
          "serviceRunning" to SonarMeshForegroundService.isRunning,
          "relayedCount" to (ble?.getRelayedCount() ?: 0),
          "acousticListening" to (modem?.isListening() ?: false),
          "sirenPlaying" to (modem?.isSirenPlaying() ?: false),
          "accelMagnitudeMs2" to 9.81,
          "lightLux" to 120.0,
          "isPocketBag" to false,
          "headingDeg" to 0.0,
        )
      }

      ensureComponents(context)
      val batIntent = try {
        context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
      } catch (_: Throwable) {
        null
      }
      val level = batIntent?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
      val scale = batIntent?.getIntExtra(BatteryManager.EXTRA_SCALE, 100) ?: 100
      val batteryPct = if (level >= 0 && scale > 0) (level * 100) / scale else 100

      val airplaneMode = try {
        Settings.Global.getInt(
          context.contentResolver,
          Settings.Global.AIRPLANE_MODE_ON,
          0,
        ) != 0
      } catch (_: Throwable) {
        false
      }

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
      SonarMeshForegroundService.onServiceErrorListener = null
      SonarMeshForegroundService.onServiceStateListener = null
      SonarMeshForegroundService.activeTransport = null
      modem?.release()
      ble?.release()
      sensors?.stop()
    }
  }
}
