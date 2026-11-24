const {
  AndroidConfig,
  withAndroidColors,
  withAndroidManifest,
  withAndroidStyles,
} = require("@expo/config-plugins");

/**
 * Expo Config Plugin for SonarMesh (SolarPUSH).
 * - Adds legacy API<=30 BLUETOOTH / BLUETOOTH_ADMIN permissions with maxSdkVersion=30.
 * - Registers hardware features (BLE, microphone, accelerometer), ForegroundService
 *   with connectedDevice + microphone types, and BLE PendingIntent BroadcastReceiver.
 * - Configures light-theme Android native colors and Theme.EdgeToEdge.Light styles.
 */
function withSonarMeshManifest(config) {
  return withAndroidManifest(config, (modConfig) => {
    const manifest = modConfig.modResults.manifest;

    if (!manifest["uses-permission"]) {
      manifest["uses-permission"] = [];
    }
    const legacyBtPermissions = [
      { name: "android.permission.BLUETOOTH", maxSdkVersion: "30" },
      { name: "android.permission.BLUETOOTH_ADMIN", maxSdkVersion: "30" },
    ];
    for (const perm of legacyBtPermissions) {
      const existing = manifest["uses-permission"].find(
        (entry) => entry.$?.["android:name"] === perm.name
      );
      if (existing) {
        existing.$["android:maxSdkVersion"] = perm.maxSdkVersion;
      } else {
        manifest["uses-permission"].push({
          $: {
            "android:name": perm.name,
            "android:maxSdkVersion": perm.maxSdkVersion,
          },
        });
      }
    }

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

function withSonarMeshLightColors(config) {
  return withAndroidColors(config, (modConfig) => {
    let xml = modConfig.modResults;
    xml = AndroidConfig.Colors.assignColorValue(xml, {
      name: "colorPrimary",
      value: "#0D9488",
    });
    xml = AndroidConfig.Colors.assignColorValue(xml, {
      name: "colorPrimaryDark",
      value: "#F7F9FC",
    });
    xml = AndroidConfig.Colors.assignColorValue(xml, {
      name: "splashscreen_background",
      value: "#F7F9FC",
    });
    xml = AndroidConfig.Colors.assignColorValue(xml, {
      name: "activityBackground",
      value: "#F7F9FC",
    });
    modConfig.modResults = xml;
    return modConfig;
  });
}

function withSonarMeshLightStyles(config) {
  return withAndroidStyles(config, (modConfig) => {
    const styles = modConfig.modResults?.resources?.style;
    if (Array.isArray(styles)) {
      const appTheme = styles.find((s) => s.$?.name === "AppTheme");
      if (appTheme) {
        appTheme.$.parent = "Theme.EdgeToEdge.Light";
        const deprecatedNames = new Set([
          "android:statusBarColor",
          "android:navigationBarColor",
        ]);
        appTheme.item = (appTheme.item ?? []).filter(
          (item) => !deprecatedNames.has(item.$?.name)
        );
      }
    }

    modConfig.modResults = AndroidConfig.Styles.assignStylesValue(
      modConfig.modResults,
      {
        add: true,
        parent: { name: "AppTheme", parent: "Theme.EdgeToEdge.Light" },
        name: "android:windowLightStatusBar",
        value: "true",
      }
    );

    modConfig.modResults = AndroidConfig.Styles.assignStylesValue(
      modConfig.modResults,
      {
        add: true,
        parent: { name: "AppTheme", parent: "Theme.EdgeToEdge.Light" },
        name: "android:windowBackground",
        value: "@color/activityBackground",
      }
    );

    return modConfig;
  });
}

function withSonarMeshAndroid(config) {
  config = withSonarMeshManifest(config);
  config = withSonarMeshLightColors(config);
  config = withSonarMeshLightStyles(config);
  return config;
}

module.exports = withSonarMeshAndroid;
