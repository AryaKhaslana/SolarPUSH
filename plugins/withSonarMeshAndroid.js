const { withAndroidManifest } = require("@expo/config-plugins");

/**
 * Expo Config Plugin for SonarMesh (SolarPUSH).
 * Registers hardware features (BLE, microphone, accelerometer), ForegroundService
 * with connectedDevice + microphone types, and BLE PendingIntent BroadcastReceiver.
 */
function withSonarMeshAndroid(config) {
  return withAndroidManifest(config, (modConfig) => {
    const manifest = modConfig.modResults.manifest;

    if (!manifest["uses-feature"]) {
      manifest["uses-feature"] = [];
    }
    const features = [
      { name: "android.hardware.bluetooth_le", required: "false" },
      { name: "android.hardware.microphone", required: "false" },
      { name: "android.hardware.sensor.accelerometer", required: "false" },
      { name: "android.hardware.sensor.light", required: "false" },
      { name: "android.hardware.sensor.compass", required: "false" },
    ];
    for (const f of features) {
      const exists = manifest["uses-feature"].some(
        (entry) => entry.$?.["android:name"] === f.name
      );
      if (!exists) {
        manifest["uses-feature"].push({
          $: { "android:name": f.name, "android:required": f.required },
        });
      }
    }

    const app = manifest.application?.[0];
    if (app) {
      if (!app.service) app.service = [];
      const serviceName = "com.aryakhaslana.sonarmesh.ble.SonarMeshForegroundService";
      const hasService = app.service.some(
        (s) => s.$?.["android:name"] === serviceName
      );
      if (!hasService) {
        app.service.push({
          $: {
            "android:name": serviceName,
            "android:enabled": "true",
            "android:exported": "false",
            "android:foregroundServiceType": "connectedDevice|microphone",
          },
        });
      }

      if (!app.receiver) app.receiver = [];
      const receiverName = "com.aryakhaslana.sonarmesh.ble.BleScanResultReceiver";
      const hasReceiver = app.receiver.some(
        (r) => r.$?.["android:name"] === receiverName
      );
      if (!hasReceiver) {
        app.receiver.push({
          $: {
            "android:name": receiverName,
            "android:enabled": "true",
            "android:exported": "false",
          },
        });
      }
    }

    return modConfig;
  });
}

module.exports = withSonarMeshAndroid;
