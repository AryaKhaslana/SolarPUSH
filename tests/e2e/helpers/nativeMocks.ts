export type MockPlatformOS = "android" | "web" | "ios";
export type MockAndroidPermissionResult = "granted" | "denied" | "never_ask_again";

export interface MockNativeErrorSpec {
  code?: string;
  message: string;
}

type EventListener = (...args: unknown[]) => void;

class InMemoryStorage implements Storage {
  private map = new Map<string, string>();

  get length(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }

  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }

  key(index: number): string | null {
    const keys = Array.from(this.map.keys());
    return keys[index] ?? null;
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }

  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
}

const STATE_KEY = Symbol.for("sonarmesh.e2e.boundaryState");

interface BoundarySingleton {
  localStorage: InMemoryStorage;
  osState: {
    platformOS: MockPlatformOS;
    platformVersion: number;
    colorScheme: "light" | "dark" | null;
    permissions: Map<string, MockAndroidPermissionResult>;
    permissionError: Error | null;
    linkingOpenSettingsCalls: number;
    linkingOpenUrlCalls: string[];
    linkingError: Error | null;
    appStateCurrent: "active" | "background" | "inactive";
    appStateListeners: Set<(state: string) => void>;
    backHandlerListeners: Set<() => boolean>;
    alertCalls: Array<{ title: string; message?: string; buttons?: unknown[] }>;
  };
  nativeState: {
    moduleNull: boolean;
    serviceRunning: boolean;
    mode: string;
    lowLatency: boolean;
    listening: boolean;
    sirenPlaying: boolean;
    batteryPct: number;
    airplaneMode: boolean;
    relayedCount: number;
    ignoringBatteryOptimizations: boolean;
    accelMagnitudeMs2: number;
    lightLux: number;
    isPocketBag: boolean;
    headingDeg: number;
    lastSensorConfig: { impactMs2: number; pocketLux: number };
    lastAcousticConfig: { freqSpace0Hz: number; freqMark1Hz: number; symbolMs: number };
    errors: Record<string, Error | null>;
    calls: Array<{ method: string; args: unknown[] }>;
  };
  nativeEventListeners: Map<string, Set<EventListener>>;
  sqliteState: {
    openError: Error | null;
    queryError: Error | null;
    kv: Map<string, string>;
    packets: Map<string, MockSqlitePacketRow>;
  };
  locationState: {
    permissionStatus: "granted" | "denied" | "undetermined";
    canAskAgain: boolean;
    coords: { latitude: number; longitude: number; accuracy: number };
    lastKnownCoords: { latitude: number; longitude: number; accuracy: number } | null;
    error: Error | null;
  };
}

function getBoundarySingleton(): BoundarySingleton {
  const g = globalThis as Record<symbol, BoundarySingleton | undefined>;
  if (!g[STATE_KEY]) {
    g[STATE_KEY] = {
      localStorage: new InMemoryStorage(),
      osState: {
        platformOS: "android",
        platformVersion: 34,
        colorScheme: "light",
        permissions: new Map<string, MockAndroidPermissionResult>(),
        permissionError: null,
        linkingOpenSettingsCalls: 0,
        linkingOpenUrlCalls: [],
        linkingError: null,
        appStateCurrent: "active",
        appStateListeners: new Set<(state: string) => void>(),
        backHandlerListeners: new Set<() => boolean>(),
        alertCalls: [],
      },
      nativeState: {
        moduleNull: false,
        serviceRunning: false,
        mode: "IDLE",
        lowLatency: false,
        listening: false,
        sirenPlaying: false,
        batteryPct: 86,
        airplaneMode: true,
        relayedCount: 0,
        ignoringBatteryOptimizations: false,
        accelMagnitudeMs2: 9.81,
        lightLux: 120,
        isPocketBag: false,
        headingDeg: 24,
        lastSensorConfig: { impactMs2: 28, pocketLux: 5 },
        lastAcousticConfig: { freqSpace0Hz: 18750, freqMark1Hz: 19500, symbolMs: 20 },
        errors: {},
        calls: [],
      },
      nativeEventListeners: new Map<string, Set<EventListener>>(),
      sqliteState: {
        openError: null,
        queryError: null,
        kv: new Map<string, string>(),
        packets: new Map<string, MockSqlitePacketRow>(),
      },
      locationState: {
        permissionStatus: "denied",
        canAskAgain: true,
        coords: {
          latitude: -6.208763,
          longitude: 106.845599,
          accuracy: 8.5,
        },
        lastKnownCoords: null,
        error: null,
      },
    };
  }
  return g[STATE_KEY]!;
}

const singleton = getBoundarySingleton();

export const mockLocalStorage = singleton.localStorage;
export const mockOsState = singleton.osState;
export const mockNativeState = singleton.nativeState;
const nativeEventListeners = singleton.nativeEventListeners;

export function addNativeListener(eventName: string, listener: EventListener): { remove: () => void } {
  let set = nativeEventListeners.get(eventName);
  if (!set) {
    set = new Set();
    nativeEventListeners.set(eventName, set);
  }
  set.add(listener);
  return {
    remove: () => {
      set?.delete(listener);
    },
  };
}

export function emitNativeEvent(eventName: string, payload: unknown): void {
  const set = nativeEventListeners.get(eventName);
  if (!set) return;
  for (const fn of Array.from(set)) {
    fn(payload);
  }
}

export function getNativeListenerCount(eventName?: string): number {
  if (eventName) {
    return nativeEventListeners.get(eventName)?.size ?? 0;
  }
  let total = 0;
  for (const set of nativeEventListeners.values()) {
    total += set.size;
  }
  return total;
}

function maybeThrowNative(method: string) {
  const err = mockNativeState.errors[method];
  if (err) throw err;
}

export const mockSonarMeshNative = {
  async startMeshService(mode: string, lowLatency: boolean) {
    mockNativeState.calls.push({ method: "startMeshService", args: [mode, lowLatency] });
    maybeThrowNative("startMeshService");
    mockNativeState.serviceRunning = true;
    mockNativeState.mode = mode;
    mockNativeState.lowLatency = lowLatency;
    emitNativeEvent("onServiceStateChanged", { running: true, mode });
    return { running: true, mode };
  },

  async stopMeshService() {
    mockNativeState.calls.push({ method: "stopMeshService", args: [] });
    maybeThrowNative("stopMeshService");
    mockNativeState.serviceRunning = false;
    mockNativeState.mode = "IDLE";
    mockNativeState.listening = false;
    mockNativeState.sirenPlaying = false;
    emitNativeEvent("onServiceStateChanged", { running: false, mode: "IDLE" });
    return { running: false };
  },

  async startAcousticListen(freqSpace0Hz: number, freqMark1Hz: number, symbolMs: number) {
    mockNativeState.calls.push({
      method: "startAcousticListen",
      args: [freqSpace0Hz, freqMark1Hz, symbolMs],
    });
    maybeThrowNative("startAcousticListen");
    mockNativeState.listening = true;
    mockNativeState.lastAcousticConfig = { freqSpace0Hz, freqMark1Hz, symbolMs };
    return { listening: true };
  },

  async stopAcousticListen() {
    mockNativeState.calls.push({ method: "stopAcousticListen", args: [] });
    maybeThrowNative("stopAcousticListen");
    mockNativeState.listening = false;
    return { listening: false };
  },

  async calibrateNoiseFloor(durationMs: number) {
    mockNativeState.calls.push({ method: "calibrateNoiseFloor", args: [durationMs] });
    maybeThrowNative("calibrateNoiseFloor");
    return { started: true, durationMs };
  },

  async transmitUltrasonic(packetBase64: string) {
    mockNativeState.calls.push({ method: "transmitUltrasonic", args: [packetBase64] });
    maybeThrowNative("transmitUltrasonic");
    return { transmitted: true, durationMs: 1200 };
  },

  async broadcastBlePacket(packetBase64: string, durationMs: number) {
    mockNativeState.calls.push({ method: "broadcastBlePacket", args: [packetBase64, durationMs] });
    maybeThrowNative("broadcastBlePacket");
    return { broadcasting: true };
  },

  async startSiren() {
    mockNativeState.calls.push({ method: "startSiren", args: [] });
    maybeThrowNative("startSiren");
    mockNativeState.sirenPlaying = true;
    return { playing: true };
  },

  async stopSiren() {
    mockNativeState.calls.push({ method: "stopSiren", args: [] });
    maybeThrowNative("stopSiren");
    mockNativeState.sirenPlaying = false;
    return { playing: false };
  },

  async updateSensorConfig(impactMs2: number, pocketLux: number) {
    mockNativeState.calls.push({ method: "updateSensorConfig", args: [impactMs2, pocketLux] });
    maybeThrowNative("updateSensorConfig");
    mockNativeState.lastSensorConfig = { impactMs2, pocketLux };
    return { updated: true };
  },

  async requestIgnoreBatteryOptimizations() {
    mockNativeState.calls.push({ method: "requestIgnoreBatteryOptimizations", args: [] });
    maybeThrowNative("requestIgnoreBatteryOptimizations");
    return { ignoring: mockNativeState.ignoringBatteryOptimizations };
  },

  async isIgnoringBatteryOptimizations() {
    mockNativeState.calls.push({ method: "isIgnoringBatteryOptimizations", args: [] });
    maybeThrowNative("isIgnoringBatteryOptimizations");
    if (mockOsState.platformOS === "android" && mockOsState.platformVersion < 23) {
      return true;
    }
    return mockNativeState.ignoringBatteryOptimizations;
  },

  async getDeviceTelemetry() {
    mockNativeState.calls.push({ method: "getDeviceTelemetry", args: [] });
    maybeThrowNative("getDeviceTelemetry");
    return {
      batteryPct: mockNativeState.batteryPct,
      airplaneMode: mockNativeState.airplaneMode,
      serviceRunning: mockNativeState.serviceRunning,
      relayedCount: mockNativeState.relayedCount,
      acousticListening: mockNativeState.listening,
      sirenPlaying: mockNativeState.sirenPlaying,
      accelMagnitudeMs2: mockNativeState.accelMagnitudeMs2,
      lightLux: mockNativeState.lightLux,
      isPocketBag: mockNativeState.isPocketBag,
      headingDeg: mockNativeState.headingDeg,
    };
  },

  addListener(eventName: string, listener: EventListener) {
    return addNativeListener(eventName, listener);
  },
};

// Stateful in-memory SQLite mock matching expo-sqlite openDatabaseAsync API
export interface MockSqlitePacketRow {
  packet_id: string;
  sender_hint: string;
  seq_counter: number;
  raw_base64: string;
  transport: string;
  rssi: number;
  snr_db: number;
  relayed: number;
  received_at_ms: number;
}

export const mockSqliteState = singleton.sqliteState;

export const mockSqliteDb = {
  async execAsync(_sql: string) {
    if (mockSqliteState.queryError) throw mockSqliteState.queryError;
  },

  async runAsync(sql: string, ...params: unknown[]) {
    if (mockSqliteState.queryError) throw mockSqliteState.queryError;
    const normalized = sql.trim().toUpperCase();
    if (normalized.includes("INTO KV_STATE")) {
      mockSqliteState.kv.set("device_state", String(params[0] ?? ""));
    } else if (normalized.includes("INTO SOS_PACKETS")) {
      const [
        packet_id,
        sender_hint,
        seq_counter,
        raw_base64,
        transport,
        rssi,
        snr_db,
        relayed,
        received_at_ms,
      ] = params;
      const key = String(packet_id);
      if (!mockSqliteState.packets.has(key)) {
        mockSqliteState.packets.set(key, {
          packet_id: key,
          sender_hint: String(sender_hint),
          seq_counter: Number(seq_counter),
          raw_base64: String(raw_base64),
          transport: String(transport),
          rssi: Number(rssi),
          snr_db: Number(snr_db),
          relayed: Number(relayed),
          received_at_ms: Number(received_at_ms),
        });
      }
    } else if (normalized.startsWith("DELETE FROM SOS_PACKETS")) {
      mockSqliteState.packets.clear();
    } else if (normalized.startsWith("DELETE FROM KV_STATE")) {
      mockSqliteState.kv.clear();
    }
    return { changes: 1 };
  },

  async getAllAsync<T>(sql: string, ...params: unknown[]): Promise<T[]> {
    if (mockSqliteState.queryError) throw mockSqliteState.queryError;
    const normalized = sql.trim().toUpperCase();
    if (normalized.includes("FROM SOS_PACKETS")) {
      const limit = Number(params[0] ?? 100);
      const rows = Array.from(mockSqliteState.packets.values()).sort(
        (a, b) => b.received_at_ms - a.received_at_ms
      );
      return rows.slice(0, limit) as unknown as T[];
    }
    return [];
  },

  async getFirstAsync<T>(sql: string): Promise<T | null> {
    if (mockSqliteState.queryError) throw mockSqliteState.queryError;
    const normalized = sql.trim().toUpperCase();
    if (normalized.includes("FROM KV_STATE")) {
      const val = mockSqliteState.kv.get("device_state");
      if (val === undefined) return null;
      return { value: val } as unknown as T;
    }
    return null;
  },
};

export const mockLocationState = singleton.locationState;

export function setMockPlatform(os: MockPlatformOS, version = 34) {
  mockOsState.platformOS = os;
  mockOsState.platformVersion = version;
}

export function setMockPermission(permission: string, result: MockAndroidPermissionResult) {
  mockOsState.permissions.set(permission, result);
}

export function grantAllAndroidPermissions() {
  const all = [
    "android.permission.BLUETOOTH_SCAN",
    "android.permission.BLUETOOTH_ADVERTISE",
    "android.permission.BLUETOOTH_CONNECT",
    "android.permission.ACCESS_FINE_LOCATION",
    "android.permission.ACCESS_COARSE_LOCATION",
    "android.permission.RECORD_AUDIO",
    "android.permission.POST_NOTIFICATIONS",
  ];
  for (const p of all) {
    mockOsState.permissions.set(p, "granted");
  }
  mockNativeState.ignoringBatteryOptimizations = true;
  mockLocationState.permissionStatus = "granted";
}

export function resetAllBoundaryMocks() {
  mockLocalStorage.clear();

  mockOsState.platformOS = "android";
  mockOsState.platformVersion = 34;
  mockOsState.colorScheme = "light";
  mockOsState.permissions.clear();
  mockOsState.permissionError = null;
  mockOsState.linkingOpenSettingsCalls = 0;
  mockOsState.linkingOpenUrlCalls = [];
  mockOsState.linkingError = null;
  mockOsState.appStateCurrent = "active";
  mockOsState.appStateListeners.clear();
  mockOsState.backHandlerListeners.clear();
  mockOsState.alertCalls = [];

  mockNativeState.moduleNull = false;
  mockNativeState.serviceRunning = false;
  mockNativeState.mode = "IDLE";
  mockNativeState.lowLatency = false;
  mockNativeState.listening = false;
  mockNativeState.sirenPlaying = false;
  mockNativeState.batteryPct = 86;
  mockNativeState.airplaneMode = true;
  mockNativeState.relayedCount = 0;
  mockNativeState.ignoringBatteryOptimizations = false;
  mockNativeState.accelMagnitudeMs2 = 9.81;
  mockNativeState.lightLux = 120;
  mockNativeState.isPocketBag = false;
  mockNativeState.headingDeg = 24;
  mockNativeState.lastSensorConfig = { impactMs2: 28, pocketLux: 5 };
  mockNativeState.lastAcousticConfig = { freqSpace0Hz: 18750, freqMark1Hz: 19500, symbolMs: 20 };
  mockNativeState.errors = {};
  mockNativeState.calls = [];

  nativeEventListeners.clear();

  mockSqliteState.openError = null;
  mockSqliteState.queryError = null;
  mockSqliteState.kv.clear();
  mockSqliteState.packets.clear();

  mockLocationState.permissionStatus = "denied";
  mockLocationState.canAskAgain = true;
  mockLocationState.coords = {
    latitude: -6.208763,
    longitude: 106.845599,
    accuracy: 8.5,
  };
  mockLocationState.lastKnownCoords = null;
  mockLocationState.error = null;
}
