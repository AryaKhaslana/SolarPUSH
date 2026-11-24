import { Platform } from "react-native";
import {
  requireOptionalNativeModule,
  type EventSubscription,
} from "expo-modules-core";

export interface NativePacketEvent {
  packetBase64: string;
  transport: "ble" | "ultrasonic";
  rssi: number;
  relayed: boolean;
  snrDb: number;
}

export interface NativeSpectrumFrame {
  startFreqHz: number;
  endFreqHz: number;
  binsDb: number[];
  peakFreqHz: number;
  noiseFloorDb: number;
  snrDb: number;
}

export interface NativeCalibrationResult {
  noiseFloorDb: number;
  thresholdDb: number;
}

export interface NativeImpactEvent {
  magnitudeMs2: number;
  isPocketBag: boolean;
}

export interface NativeSensorTelemetry {
  accelMagnitudeMs2: number;
  lightLux: number;
  isPocketBag: boolean;
  headingDeg: number;
}

export interface NativeDeviceTelemetry extends NativeSensorTelemetry {
  batteryPct: number;
  airplaneMode: boolean;
  serviceRunning: boolean;
  relayedCount: number;
  acousticListening: boolean;
  sirenPlaying: boolean;
}

export interface NativeServiceStateEvent {
  running: boolean;
  mode: string;
}

export interface NativeErrorEvent {
  source?: string;
  code?: string;
  message?: string;
}

export type SonarMeshNativeEvents = {
  onPacketReceived: (ev: NativePacketEvent) => void;
  onSpectrumFrame: (frame: NativeSpectrumFrame) => void;
  onCalibrationResult: (res: NativeCalibrationResult) => void;
  onImpactDetected: (ev: NativeImpactEvent) => void;
  onSensorTelemetry: (snap: NativeSensorTelemetry) => void;
  onServiceStateChanged: (ev: NativeServiceStateEvent) => void;
  onNativeError: (ev: NativeErrorEvent) => void;
};

export interface SonarMeshNativeEventEmitter {
  addListener<K extends keyof SonarMeshNativeEvents>(
    eventName: K,
    listener: SonarMeshNativeEvents[K]
  ): EventSubscription;
  removeAllListeners?<K extends keyof SonarMeshNativeEvents>(eventName: K): void;
}

export interface SonarMeshNativeModuleType extends SonarMeshNativeEventEmitter {
  startMeshService(mode: string, lowLatency: boolean): Promise<{ running: boolean; mode: string }>;
  stopMeshService(): Promise<{ running: boolean }>;
  startAcousticListen(
    freqSpace0Hz: number,
    freqMark1Hz: number,
    symbolMs: number
  ): Promise<{ listening: boolean }>;
  stopAcousticListen(): Promise<{ listening: boolean }>;
  calibrateNoiseFloor(durationMs: number): Promise<{ started: boolean; durationMs: number }>;
  transmitUltrasonic(packetBase64: string): Promise<{ transmitted: boolean; durationMs: number }>;
  broadcastBlePacket(packetBase64: string, durationMs: number): Promise<{ broadcasting: boolean }>;
  startSiren(): Promise<{ playing: boolean }>;
  stopSiren(): Promise<{ playing: boolean }>;
  updateSensorConfig(impactMs2: number, pocketLux: number): Promise<{ updated: boolean }>;
  isIgnoringBatteryOptimizations(): Promise<boolean>;
  requestIgnoreBatteryOptimizations(): Promise<{ ignoring: boolean }>;
  getDeviceTelemetry(): Promise<NativeDeviceTelemetry>;
}

let nativeMod: SonarMeshNativeModuleType | null = null;
if (Platform.OS === "android") {
  try {
    nativeMod = requireOptionalNativeModule<SonarMeshNativeModuleType>("SonarMeshNative");
  } catch {
    nativeMod = null;
  }
}

export const isNativeAndroidModuleAvailable = nativeMod !== null;

export const SonarMeshNative = nativeMod;

export function createNativeEventEmitter(): SonarMeshNativeModuleType | null {
  if (!nativeMod || typeof nativeMod.addListener !== "function") return null;
  return nativeMod;
}

export function addNativeListener<K extends keyof SonarMeshNativeEvents>(
  eventName: K,
  listener: SonarMeshNativeEvents[K]
): EventSubscription | null {
  const emitter = createNativeEventEmitter();
  if (!emitter) return null;
  return emitter.addListener(eventName, listener);
}
