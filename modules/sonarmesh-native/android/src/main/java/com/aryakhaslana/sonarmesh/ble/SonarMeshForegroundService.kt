package com.aryakhaslana.sonarmesh.ble

import android.Manifest
import android.app.ForegroundServiceStartNotAllowedException
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.bluetooth.le.BluetoothLeScanner
import android.bluetooth.le.ScanResult
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.annotation.RequiresApi
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

/**
 * Resilient Android ForegroundService (connectedDevice, plus on-demand microphone only when
 * acoustic radar is actively listening) keeping BLE mesh relay alive while screen is off.
 */
class SonarMeshForegroundService : Service() {
  companion object {
    const val CHANNEL_ID = "sonarmesh_mesh_channel"
    const val NOTIFICATION_ID = 5151
    const val ACTION_START = "com.aryakhaslana.sonarmesh.START_MESH"
    const val ACTION_STOP = "com.aryakhaslana.sonarmesh.STOP_MESH"
    const val EXTRA_MODE = "mode"
    const val EXTRA_WITH_MIC = "withMic"

    @Volatile var isRunning: Boolean = false
      private set

    @Volatile var activeTransport: BleMeshTransport? = null
    @Volatile var onServiceStateListener: ((Boolean, String) -> Unit)? = null
    @Volatile var onServiceErrorListener: ((String, String) -> Unit)? = null
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    ensureChannel()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      stopServiceCleanly()
      return START_NOT_STICKY
    }

    if (!hasConnectedDevicePermission()) {
      isRunning = false
      onServiceErrorListener?.invoke(
        "PERMISSION_DENIED",
        "Bluetooth permission required for mesh foreground service",
      )
      onServiceStateListener?.invoke(false, "IDLE")
      try {
        stopSelf()
      } catch (_: Throwable) {
      }
      return START_NOT_STICKY
    }

    val mode = intent?.getStringExtra(EXTRA_MODE) ?: "RADAR"
    val withMic = intent?.getBooleanExtra(EXTRA_WITH_MIC, false) ?: false
    val notification = buildNotification(mode)

    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        var svcType = ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE
        if (withMic && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && hasRecordAudioPermission()) {
          svcType = svcType or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
        }
        startForeground(NOTIFICATION_ID, notification, svcType)
      } else {
        startForeground(NOTIFICATION_ID, notification)
      }
      isRunning = true
      onServiceStateListener?.invoke(true, mode)
      return START_STICKY
    } catch (se: SecurityException) {
      handleStartFailure("PERMISSION_DENIED", se.message ?: "Foreground service permission denied")
      return START_NOT_STICKY
    } catch (ise: IllegalStateException) {
      val code = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && isForegroundStartNotAllowed(ise)) {
        "FGS_NOT_ALLOWED"
      } else {
        "FGS_ILLEGAL_STATE"
      }
      handleStartFailure(code, ise.message ?: "Unable to start mesh foreground service")
      return START_NOT_STICKY
    } catch (t: Throwable) {
      handleStartFailure("FGS_ERROR", t.message ?: "Unexpected foreground service error")
      return START_NOT_STICKY
    }
  }

  private fun stopServiceCleanly() {
    isRunning = false
    try {
      activeTransport?.stopScanning()
    } catch (_: Throwable) {
    }
    try {
      ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
    } catch (_: Throwable) {
    }
    onServiceStateListener?.invoke(false, "IDLE")
    try {
      stopSelf()
    } catch (_: Throwable) {
    }
  }

  private fun handleStartFailure(code: String, message: String) {
    isRunning = false
    onServiceErrorListener?.invoke(code, message)
    onServiceStateListener?.invoke(false, "IDLE")
    try {
      ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
    } catch (_: Throwable) {
    }
    try {
      stopSelf()
    } catch (_: Throwable) {
    }
  }

  private fun hasConnectedDevicePermission(): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true
    return ContextCompat.checkSelfPermission(this, Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED ||
      ContextCompat.checkSelfPermission(this, Manifest.permission.BLUETOOTH_SCAN) == PackageManager.PERMISSION_GRANTED ||
      ContextCompat.checkSelfPermission(this, Manifest.permission.BLUETOOTH_ADVERTISE) == PackageManager.PERMISSION_GRANTED
  }

  private fun hasRecordAudioPermission(): Boolean =
    ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

  @RequiresApi(Build.VERSION_CODES.S)
  private fun isForegroundStartNotAllowed(t: Throwable): Boolean =
    t is ForegroundServiceStartNotAllowedException

  override fun onDestroy() {
    isRunning = false
    super.onDestroy()
  }

  private fun ensureChannel() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val mgr = getSystemService(NotificationManager::class.java) ?: return
      val channel = NotificationChannel(
        CHANNEL_ID,
        "SonarMesh Offline Mesh",
        NotificationManager.IMPORTANCE_LOW,
      ).apply {
        description = "Keeps offline BLE SOS relay and disaster radar active without network."
      }
      try {
        mgr.createNotificationChannel(channel)
      } catch (_: Throwable) {
      }
    }
  }

  private fun buildNotification(mode: String): Notification {
    val stopIntent = Intent(this, SonarMeshForegroundService::class.java).apply {
      action = ACTION_STOP
    }
    val stopPi = PendingIntent.getService(
      this,
      5152,
      stopIntent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

    val label = if (mode == "SOS") "SOS Beacon Broadcasting (Offline)" else "Offline BLE Radar Active"
    return NotificationCompat.Builder(this, CHANNEL_ID)
      .setContentTitle("SonarMesh · $label")
      .setContentText("SMPv1 56B relay standby · Airplane Mode compatible")
      .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
      .setOngoing(true)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Stop Mesh", stopPi)
      .build()
  }
}

/**
 * Receives hardware-filtered BLE scan batches dispatched via PendingIntent even during doze.
 */
class BleScanResultReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != BleMeshTransport.ACTION_BLE_SCAN_BATCH) return
    val results = try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        intent.getParcelableArrayListExtra(BluetoothLeScanner.EXTRA_LIST_SCAN_RESULT, ScanResult::class.java)
      } else {
        @Suppress("DEPRECATION")
        intent.getParcelableArrayListExtra<ScanResult>(BluetoothLeScanner.EXTRA_LIST_SCAN_RESULT)
      }
    } catch (_: Throwable) {
      null
    } ?: return

    val transport = SonarMeshForegroundService.activeTransport ?: return
    for (res in results) {
      try {
        transport.handleScanResult(res)
      } catch (_: Throwable) {
      }
    }
  }
}
