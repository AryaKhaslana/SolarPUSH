import { Platform } from "react-native";
import { requireOptionalNativeModule, EventEmitter } from "expo-modules-core";

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

export interface SonarMeshNativeModuleType {
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
  requestIgnoreBatteryOptimizations(): Promise<{ ignoring: boolean }>;
  getDeviceTelemetry(): Promise<NativeDeviceTelemetry>;
  addListener?: (eventName: string, listener: (...args: unknown[]) => void) => { remove: () => void };
}

const nativeMod =
  Platform.OS === "android"
    ? requireOptionalNativeModule<SonarMeshNativeModuleType>("SonarMeshNative")
    : null;

export const isNativeAndroidModuleAvailable = nativeMod !== null;

export const SonarMeshNative = nativeMod;

export function createNativeEventEmitter() {
  if (!nativeMod) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new EventEmitter(nativeMod as any);
}
