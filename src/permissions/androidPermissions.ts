import { Linking, PermissionsAndroid, Platform, type Permission } from "react-native";
import { sonarMeshBridge } from "@/native/sonarMeshBridge";

export type PermissionKey =
  | "bluetooth"
  | "location"
  | "microphone"
  | "notifications"
  | "battery";

export type PermissionStatus = "granted" | "denied" | "blocked";

export interface PermissionSnapshot {
  bluetooth: boolean;
  location: boolean;
  microphone: boolean;
  notifications: boolean;
  battery: boolean;
}

export interface DetailedPermissionSnapshot {
  bluetooth: PermissionStatus;
  location: PermissionStatus;
  microphone: PermissionStatus;
  notifications: PermissionStatus;
  batteryOptimization: PermissionStatus;
}

export const INITIAL_PERMISSIONS: PermissionSnapshot = {
  bluetooth: Platform.OS !== "android",
  location: Platform.OS !== "android",
  microphone: Platform.OS !== "android",
  notifications: Platform.OS !== "android",
  battery: Platform.OS !== "android",
};

function androidApiLevel(): number {
  if (Platform.OS !== "android") return 0;
  return typeof Platform.Version === "number"
    ? Platform.Version
    : parseInt(String(Platform.Version), 10) || 33;
}

function permissionsForKey(key: Exclude<PermissionKey, "battery">): Permission[] {
  const api = androidApiLevel();
  switch (key) {
    case "bluetooth":
      if (api >= 31) {
        return [
          "android.permission.BLUETOOTH_SCAN" as Permission,
          "android.permission.BLUETOOTH_ADVERTISE" as Permission,
          "android.permission.BLUETOOTH_CONNECT" as Permission,
        ];
      }
      return [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION];
    case "location":
      return [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION];
    case "microphone":
      return [PermissionsAndroid.PERMISSIONS.RECORD_AUDIO];
    case "notifications":
      if (api >= 33) {
        return ["android.permission.POST_NOTIFICATIONS" as Permission];
      }
      return [];
  }
}

async function checkAllGranted(perms: Permission[]): Promise<boolean> {
  if (perms.length === 0) return true;
  try {
    const results = await Promise.all(
      perms.map((p) => PermissionsAndroid.check(p).catch(() => false))
    );
    return results.every(Boolean);
  } catch {
    return false;
  }
}

export async function checkAllPermissions(): Promise<PermissionSnapshot> {
  if (Platform.OS !== "android") {
    return {
      bluetooth: true,
      location: true,
      microphone: true,
      notifications: true,
      battery: true,
    };
  }

  const [bluetooth, location, microphone, notifications, battery] = await Promise.all([
    checkAllGranted(permissionsForKey("bluetooth")),
    checkAllGranted(permissionsForKey("location")),
    checkAllGranted(permissionsForKey("microphone")),
    checkAllGranted(permissionsForKey("notifications")),
    sonarMeshBridge.isIgnoringBatteryOptimizations().catch(() => false),
  ]);

  return { bluetooth, location, microphone, notifications, battery };
}

export async function getPermissionSnapshot(): Promise<DetailedPermissionSnapshot> {
  const snap = await checkAllPermissions();
  return {
    bluetooth: snap.bluetooth ? "granted" : "denied",
    location: snap.location ? "granted" : "denied",
    microphone: snap.microphone ? "granted" : "denied",
    notifications: snap.notifications ? "granted" : "denied",
    batteryOptimization: snap.battery ? "granted" : "denied",
  };
}

export async function requestPermission(
  key: PermissionKey | "batteryOptimization"
): Promise<PermissionStatus> {
  if (Platform.OS !== "android") return "granted";

  if (key === "battery" || key === "batteryOptimization") {
    try {
      await sonarMeshBridge.requestIgnoreBatteryOptimizations();
      const ignoring = await sonarMeshBridge.isIgnoringBatteryOptimizations();
      return ignoring ? "granted" : "denied";
    } catch {
      return "denied";
    }
  }

  const perms = permissionsForKey(key);
  if (perms.length === 0) return "granted";

  try {
    const grantedMap = await PermissionsAndroid.requestMultiple(perms);
    const results = perms.map((p) => grantedMap[p]);
    if (results.every((r) => r === PermissionsAndroid.RESULTS.GRANTED)) {
      return "granted";
    }
    if (results.some((r) => r === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN)) {
      return "blocked";
    }
    return "denied";
  } catch {
    return "denied";
  }
}

export async function requestSinglePermission(key: PermissionKey): Promise<boolean> {
  const status = await requestPermission(key);
  return status === "granted";
}

export async function requestAllRuntimePermissions(): Promise<PermissionSnapshot> {
  if (Platform.OS !== "android") {
    return {
      bluetooth: true,
      location: true,
      microphone: true,
      notifications: true,
      battery: true,
    };
  }

  const uniquePerms = Array.from(
    new Set<Permission>([
      ...permissionsForKey("bluetooth"),
      ...permissionsForKey("location"),
      ...permissionsForKey("microphone"),
      ...permissionsForKey("notifications"),
    ])
  );

  try {
    if (uniquePerms.length > 0) {
      await PermissionsAndroid.requestMultiple(uniquePerms);
    }
  } catch {
    // Keep app running safely even if OS dialog is dismissed or unavailable.
  }

  return checkAllPermissions();
}

export function hasMeshBluetoothPermission(
  perms: PermissionSnapshot | DetailedPermissionSnapshot
): boolean {
  if (Platform.OS !== "android") return true;
  const api = androidApiLevel();
  const isGranted = (v: boolean | PermissionStatus) => v === true || v === "granted";
  if (api < 31) {
    return isGranted(perms.location);
  }
  return isGranted(perms.bluetooth);
}

export function hasMicrophonePermission(
  perms: PermissionSnapshot | DetailedPermissionSnapshot
): boolean {
  if (Platform.OS !== "android") return true;
  return perms.microphone === true || perms.microphone === "granted";
}

export function canStartMeshSafely(perms: PermissionSnapshot): boolean {
  if (Platform.OS !== "android") return true;
  // Android 14+ connectedDevice foreground service requires Bluetooth permissions.
  return hasMeshBluetoothPermission(perms) && perms.location;
}

export function listMissingCorePermissions(perms: PermissionSnapshot): string[] {
  const missing: string[] = [];
  if (!perms.bluetooth) missing.push("Bluetooth");
  if (!perms.location) missing.push("Lokasi");
  if (!perms.microphone) missing.push("Mikrofon");
  if (!perms.notifications) missing.push("Notifikasi");
  return missing;
}

export async function openAppSettings(): Promise<void> {
  try {
    await Linking.openSettings();
  } catch {
    // Ignore if OS settings intent is unavailable.
  }
}
