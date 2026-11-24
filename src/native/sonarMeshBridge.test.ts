import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SONARMESH_SETTINGS } from "@/config/sonarmeshConfig";
import { encodeSmpV1, type SmpV1Packet } from "@/protocol/smpv1";

const mockPlatform = { OS: "web" as "android" | "web" };
const mockRequireOptionalNativeModule = vi.fn();

vi.mock("react-native", () => ({
  Platform: mockPlatform,
}));

vi.mock("expo-modules-core", () => ({
  requireOptionalNativeModule: mockRequireOptionalNativeModule,
}));

function sampleBytes(): Uint8Array {
  const pkt: SmpV1Packet = {
    triggerType: "DAILY_RADAR",
    envPocketBag: false,
    sirenReq: false,
    ttl: 3,
    packetId: "0011223344556677",
    seqCounter: 2,
    latitude: -7.25,
    longitude: 112.75,
    gpsAccBucket: 1,
    batteryQuant: 14,
    ageSec: 1,
    senderHint: "12345678",
    powNonce: 9,
    shortPayload: "TEST",
  };
  return encodeSmpV1(pkt);
}

describe("SonarMeshBridge safety & native eventing", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("operates safely in Web / missing native module mode", async () => {
    mockPlatform.OS = "web";
    mockRequireOptionalNativeModule.mockReturnValue(null);

    const { SonarMeshBridge } = await import("./sonarMeshBridge");
    const bridge = new SonarMeshBridge();

    expect(bridge.nativeAvailable).toBe(false);
    await expect(bridge.isIgnoringBatteryOptimizations()).resolves.toBe(true);
    await expect(bridge.requestIgnoreBatteryOptimizations()).resolves.toBe(true);

    const onSensors = vi.fn();
    bridge.attach({
      onPacket: vi.fn(),
      onSpectrum: vi.fn(),
      onCalibration: vi.fn(),
      onImpact: vi.fn(),
      onSensors,
      onError: vi.fn(),
    });

    await expect(
      bridge.startMesh("RADAR", false, DEFAULT_SONARMESH_SETTINGS)
    ).resolves.toBe(true);
    expect(onSensors).toHaveBeenCalledTimes(1);
    await expect(bridge.stopMesh()).resolves.toBeUndefined();
    bridge.detach();
  });

  it("attaches directly to NativeModule.addListener and catches native promise rejections cleanly", async () => {
    mockPlatform.OS = "android";
    const listeners = new Map<string, (payload: unknown) => void>();
    const mockNative = {
      addListener: vi.fn((eventName: string, listener: (payload: unknown) => void) => {
        listeners.set(eventName, listener);
        return { remove: vi.fn() };
      }),
      startMeshService: vi.fn().mockRejectedValue(new Error("Bluetooth permission denied")),
      stopMeshService: vi.fn().mockRejectedValue(new Error("Stop failed")),
      startAcousticListen: vi.fn().mockRejectedValue(new Error("Mic denied")),
      stopAcousticListen: vi.fn().mockResolvedValue({ listening: false }),
      calibrateNoiseFloor: vi.fn().mockRejectedValue(new Error("Calib failed")),
      transmitUltrasonic: vi.fn().mockRejectedValue(new Error("Audio TX failed")),
      broadcastBlePacket: vi.fn().mockRejectedValue(new Error("BLE TX failed")),
      startSiren: vi.fn().mockRejectedValue(new Error("Siren failed")),
      stopSiren: vi.fn().mockResolvedValue({ playing: false }),
      updateSensorConfig: vi.fn().mockResolvedValue({ updated: true }),
      isIgnoringBatteryOptimizations: vi.fn().mockRejectedValue(new Error("PM error")),
      requestIgnoreBatteryOptimizations: vi.fn().mockRejectedValue(new Error("Activity missing")),
      getDeviceTelemetry: vi.fn(),
    };
    mockRequireOptionalNativeModule.mockReturnValue(mockNative);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { SonarMeshBridge } = await import("./sonarMeshBridge");
    const bridge = new SonarMeshBridge();

    expect(bridge.nativeAvailable).toBe(true);

    const onPacket = vi.fn();
    const onError = vi.fn();
    bridge.attach({
      onPacket,
      onSpectrum: vi.fn(),
      onCalibration: vi.fn(),
      onImpact: vi.fn(),
      onSensors: vi.fn(),
      onError,
    });

    expect(mockNative.addListener).toHaveBeenCalledTimes(6);
    listeners.get("onPacketReceived")?.({
      packetBase64: "AAAA",
      transport: "ble",
      rssi: -60,
      relayed: false,
      snrDb: 0,
    });
    expect(onPacket).toHaveBeenCalledTimes(1);

    listeners.get("onNativeError")?.({ message: "Native FGS error" });
    expect(onError).toHaveBeenCalledWith("Native FGS error");

    await expect(
      bridge.startMesh("RADAR", false, DEFAULT_SONARMESH_SETTINGS)
    ).resolves.toBe(false);
    await expect(
      bridge.startAcousticListen(DEFAULT_SONARMESH_SETTINGS)
    ).resolves.toBe(false);
    await expect(bridge.broadcastBle(sampleBytes())).resolves.toBe(false);
    await expect(bridge.transmitUltrasonic(sampleBytes())).resolves.toBe(false);
    await expect(bridge.startSiren()).resolves.toBe(false);
    await expect(bridge.isIgnoringBatteryOptimizations()).resolves.toBe(false);
    await expect(bridge.requestIgnoreBatteryOptimizations()).resolves.toBe(false);

    expect(warnSpy).toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith("Bluetooth permission denied");
    expect(onError).toHaveBeenCalledWith("Mic denied");
    expect(onError).toHaveBeenCalledWith("BLE TX failed");
    expect(onError).toHaveBeenCalledWith("Audio TX failed");
    bridge.detach();
  });
});
