import fs from "node:fs";
import path from "node:path";
import React from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SONARMESH_SETTINGS } from "@/config/sonarmeshConfig";
import {
  accuracyMetersToBucket,
  batteryPctToQuant,
  estimateDistanceFromRssi,
  haversineMeters,
} from "@/protocol/geo";
import {
  PacketDeduplicator,
  base64ToBytes,
  bytesToBase64,
  decodeSmpV1,
  encodeSmpV1,
  frameForAcoustic,
  prepareRelayPacket,
  type SmpV1Packet,
} from "@/protocol/smpv1";
import {
  emitNativeEvent,
  getNativeListenerCount,
  grantAllAndroidPermissions,
  mockLocationState,
  mockNativeState,
  mockOsState,
  mockSqliteState,
  setMockPermission,
  setMockPlatform,
} from "./helpers/nativeMocks";

const ROOT_DIR = path.resolve(__dirname, "../..");

function makeSamplePacket(overrides: Partial<SmpV1Packet> = {}): SmpV1Packet {
  return {
    triggerType: "SENSOR_SOS",
    envPocketBag: true,
    sirenReq: false,
    ttl: 4,
    packetId: "0123456789abcdef",
    seqCounter: 42,
    latitude: -7.257472,
    longitude: 112.752088,
    gpsAccBucket: 2,
    batteryQuant: 12,
    ageSec: 18,
    senderHint: "deadbeef",
    powNonce: 305,
    shortPayload: "HELP 2F!",
    ...overrides,
  };
}

async function flushMicrotasks(rounds = 6) {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 1500,
  stepMs = 10
): Promise<void> {
  const maxSteps = Math.max(10, Math.ceil(timeoutMs / stepMs));
  for (let i = 0; i < maxSteps; i++) {
    if (predicate()) return;
    await React.act(async () => {
      await flushMicrotasks();
      if (vi.isFakeTimers()) {
        await vi.advanceTimersByTimeAsync(stepMs);
      } else {
        await new Promise((r) => setTimeout(r, stepMs));
      }
    });
  }
  if (!predicate()) {
    throw new Error(`Condition not met within ${timeoutMs}ms`);
  }
}

async function mountUseSonarMeshApp() {
  const mod = (await import("@/state/useSonarMeshApp")) as {
    useSonarMeshApp?: () => Record<string, unknown>;
    default?: () => Record<string, unknown>;
  };
  const useSonarMeshApp = mod.useSonarMeshApp ?? mod.default;
  if (typeof useSonarMeshApp !== "function") {
    throw new Error("useSonarMeshApp export not found");
  }

  let latest: Record<string, unknown> | null = null;
  function Harness() {
    latest = useSonarMeshApp!();
    return null;
  }

  const container = document.createElement("div");
  const root = createRoot(container);
  await React.act(async () => {
    root.render(React.createElement(Harness));
  });
  await waitForCondition(() => latest !== null && latest.bootStatus !== "loading");

  return {
    get state(): Record<string, any> {
      if (!latest) throw new Error("Hook state not initialized");
      return latest;
    },
    async run(fn: () => Promise<unknown> | unknown) {
      await React.act(async () => {
        await fn();
        await flushMicrotasks();
      });
    },
    async unmount() {
      await React.act(async () => {
        root.unmount();
      });
    },
  };
}

describe("Tier 2 Boundary & Negative E2E (F1-F11, F13)", () => {
  describe("F1: SMPv1 56B Codec Boundaries", () => {
    it("T2-F1-1: decodeSmpV1 rejects lengths 0, 55, and 57 with INVALID_LENGTH", () => {
      const valid56 = encodeSmpV1(makeSamplePacket());
      for (const bad of [new Uint8Array(0), valid56.subarray(0, 55), new Uint8Array(57)]) {
        const res = decodeSmpV1(bad);
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.reason).toBe("INVALID_LENGTH");
      }
    });

    it("T2-F1-2: decodeSmpV1 rejects any MAGIC_VER !== 0x51 with INVALID_MAGIC", () => {
      const valid56 = encodeSmpV1(makeSamplePacket());
      for (const badMagic of [0x00, 0x50, 0xff]) {
        const copy = valid56.slice();
        copy[0] = badMagic;
        const res = decodeSmpV1(copy);
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.reason).toBe("INVALID_MAGIC");
      }
    });

    it("T2-F1-3: single-bit flip in every byte region fails with CRC_MISMATCH", () => {
      const valid56 = encodeSmpV1(makeSamplePacket());
      for (const idx of [1, 5, 13, 30, 42, 54, 55]) {
        const corrupted = valid56.slice();
        corrupted[idx] ^= 0x01;
        const res = decodeSmpV1(corrupted);
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.reason).toBe("CRC_MISMATCH");
      }
    });

    it("T2-F1-4: extreme numeric BVA clamps coordinates, ttl, seqCounter, ageSec, gpsAccBucket, and batteryQuant", () => {
      const low = encodeSmpV1(
        makeSamplePacket({
          latitude: -95,
          longitude: -200,
          ttl: -1,
          seqCounter: 0,
          ageSec: 0,
          gpsAccBucket: -2,
          batteryQuant: -5,
        })
      );
      const decLow = decodeSmpV1(low);
      expect(decLow.ok).toBe(true);
      if (decLow.ok) {
        expect(decLow.packet.latitude).toBeCloseTo(-90, 6);
        expect(decLow.packet.longitude).toBeCloseTo(-180, 6);
        expect(decLow.packet.ttl).toBe(0);
        expect(decLow.packet.seqCounter).toBe(0);
        expect(decLow.packet.ageSec).toBe(0);
        expect(decLow.packet.gpsAccBucket).toBe(0);
        expect(decLow.packet.batteryQuant).toBe(0);
      }

      const high = encodeSmpV1(
        makeSamplePacket({
          latitude: 95,
          longitude: 200,
          ttl: 99,
          seqCounter: 70000,
          ageSec: 70000,
          gpsAccBucket: 20,
          batteryQuant: 20,
        })
      );
      const decHigh = decodeSmpV1(high);
      expect(decHigh.ok).toBe(true);
      if (decHigh.ok) {
        expect(decHigh.packet.latitude).toBeCloseTo(90, 6);
        expect(decHigh.packet.longitude).toBeCloseTo(180, 6);
        expect(decHigh.packet.ttl).toBe(15);
        expect(decHigh.packet.seqCounter).toBe(65535);
        expect(decHigh.packet.ageSec).toBe(65535);
        expect(decHigh.packet.gpsAccBucket).toBe(15);
        expect(decHigh.packet.batteryQuant).toBe(15);
      }
    });

    it("T2-F1-5: shortPayload UTF-8 boundary handles empty, exact 9B, 15B truncation, and multi-byte emoji safely", () => {
      const validAuth = encodeSmpV1(makeSamplePacket({ shortPayload: "" }));
      const decEmpty = decodeSmpV1(validAuth);
      expect(decEmpty.ok).toBe(true);
      if (decEmpty.ok) expect(decEmpty.packet.shortPayload).toBe("");

      const decExact = decodeSmpV1(encodeSmpV1(makeSamplePacket({ shortPayload: "123456789" })));
      expect(decExact.ok).toBe(true);
      if (decExact.ok) expect(decExact.packet.shortPayload).toBe("123456789");

      const decTrunc = decodeSmpV1(
        encodeSmpV1(makeSamplePacket({ shortPayload: "123456789ABCDEF" }))
      );
      expect(decTrunc.ok).toBe(true);
      if (decTrunc.ok) expect(decTrunc.packet.shortPayload).toBe("123456789");

      const multiByteRaw = encodeSmpV1(makeSamplePacket({ shortPayload: "🆘DARURAT!" }));
      expect(multiByteRaw.length).toBe(56);
      const decMulti = decodeSmpV1(multiByteRaw);
      expect(decMulti.ok).toBe(true);
    });
  });

  describe("F2: Dedup & Anti-Replay Boundaries", () => {
    it("T2-F2-1: DEDUP_WINDOW_MS boundary rejects at t0 + 599999 and accepts at t0 + 600000", () => {
      const dedup = new PacketDeduplicator(512, 600_000);
      const pkt = makeSamplePacket({ packetId: "1010101010101010", seqCounter: 5 });
      expect(dedup.acceptIfFresh(pkt, 1_000_000)).toBe(true);
      expect(dedup.acceptIfFresh(pkt, 1_599_999)).toBe(false);
      expect(dedup.acceptIfFresh(pkt, 1_600_000)).toBe(true);
    });

    it("T2-F2-2: stale replay seqCounter=41 after 42 is rejected even with brand-new packetId", () => {
      const dedup = new PacketDeduplicator();
      expect(
        dedup.acceptIfFresh(
          makeSamplePacket({ senderHint: "abcd1234", packetId: "0000000000000001", seqCounter: 42 }),
          1000
        )
      ).toBe(true);
      expect(
        dedup.acceptIfFresh(
          makeSamplePacket({ senderHint: "abcd1234", packetId: "0000000000000002", seqCounter: 41 }),
          2000
        )
      ).toBe(false);
    });

    it("T2-F2-3: 16-bit seqCounter wraparound accepts seq=0 after 65535 and rejects seq=32768", () => {
      const dedup = new PacketDeduplicator();
      expect(
        dedup.acceptIfFresh(
          makeSamplePacket({ senderHint: "ff00ff00", packetId: "0000000000000010", seqCounter: 65535 }),
          1000
        )
      ).toBe(true);
      // 65535 - 32768 = 32767 < 32768 -> stale
      expect(
        dedup.acceptIfFresh(
          makeSamplePacket({ senderHint: "ff00ff00", packetId: "0000000000000011", seqCounter: 32768 }),
          2000
        )
      ).toBe(false);
      // 65535 - 0 = 65535 >= 32768 -> wraparound accepted
      expect(
        dedup.acceptIfFresh(
          makeSamplePacket({ senderHint: "ff00ff00", packetId: "0000000000000012", seqCounter: 0 }),
          3000
        )
      ).toBe(true);
    });

    it("T2-F2-4: same seqCounter with different packetId is accepted while duplicate packetId with higher seqCounter is rejected", () => {
      const dedup = new PacketDeduplicator();
      expect(
        dedup.acceptIfFresh(
          makeSamplePacket({ senderHint: "11223344", packetId: "aaaaaaaaaaaaaaaa", seqCounter: 42 }),
          1000
        )
      ).toBe(true);
      expect(
        dedup.acceptIfFresh(
          makeSamplePacket({ senderHint: "11223344", packetId: "bbbbbbbbbbbbbbbb", seqCounter: 42 }),
          2000
        )
      ).toBe(true);
      expect(
        dedup.acceptIfFresh(
          makeSamplePacket({ senderHint: "11223344", packetId: "aaaaaaaaaaaaaaaa", seqCounter: 43 }),
          3000
        )
      ).toBe(false);
    });

    it("T2-F2-5: maxEntries=512 evicts 1st entry after 513 distinct packetIds", () => {
      const dedup = new PacketDeduplicator(512, 600_000);
      for (let i = 0; i < 513; i++) {
        const pid = i.toString(16).padStart(16, "0");
        expect(
          dedup.acceptIfFresh(
            makeSamplePacket({ senderHint: "77777777", packetId: pid, seqCounter: i + 1 }),
            10_000 + i
          )
        ).toBe(true);
      }
      // First packetId (0000...0000) was evicted; re-inserting with newer seq is accepted
      expect(
        dedup.acceptIfFresh(
          makeSamplePacket({
            senderHint: "77777777",
            packetId: "0".padStart(16, "0"),
            seqCounter: 514,
          }),
          20_000
        )
      ).toBe(true);
    });
  });

  describe("F3: Multi-Hop TTL & Relay Boundaries", () => {
    it("T2-F3-1: prepareRelayPacket returns null for ttl=0, ttl=-1, and ttl=1", () => {
      expect(prepareRelayPacket(makeSamplePacket({ ttl: 0 }), 2)).toBeNull();
      expect(prepareRelayPacket(makeSamplePacket({ ttl: -1 }), 2)).toBeNull();
      expect(prepareRelayPacket(makeSamplePacket({ ttl: 1 }), 2)).toBeNull();
    });

    it("T2-F3-2: ttl=15 relays to 14 and ttl=2 relays to 1", () => {
      const r15 = decodeSmpV1(prepareRelayPacket(makeSamplePacket({ ttl: 15 }), 1)!);
      const r2 = decodeSmpV1(prepareRelayPacket(makeSamplePacket({ ttl: 2 }), 1)!);
      expect(r15.ok && r15.packet.ttl).toBe(14);
      expect(r2.ok && r2.packet.ttl).toBe(1);
    });

    it("T2-F3-3: ageSec saturates at 65535 without wrapping", () => {
      const relayed = prepareRelayPacket(makeSamplePacket({ ttl: 3, ageSec: 65530 }), 20);
      const dec = decodeSmpV1(relayed!);
      expect(dec.ok).toBe(true);
      if (dec.ok) expect(dec.packet.ageSec).toBe(65535);
    });

    it("T2-F3-4: elapsedSec <= 0 still increments ageSec by at least 1", () => {
      const r0 = decodeSmpV1(prepareRelayPacket(makeSamplePacket({ ttl: 3, ageSec: 10 }), 0)!);
      const rNeg = decodeSmpV1(prepareRelayPacket(makeSamplePacket({ ttl: 3, ageSec: 10 }), -5)!);
      expect(r0.ok && r0.packet.ageSec).toBe(11);
      expect(rNeg.ok && rNeg.packet.ageSec).toBe(11);
    });

    it("T2-F3-5: relay preserves packetId, senderHint, seqCounter, flags, coords, and shortPayload verbatim", () => {
      const original = makeSamplePacket({
        triggerType: "WITNESS_PIN",
        envPocketBag: true,
        sirenReq: true,
        ttl: 5,
        shortPayload: "RUMAH B3",
      });
      const dec = decodeSmpV1(prepareRelayPacket(original, 4)!);
      expect(dec.ok).toBe(true);
      if (!dec.ok) return;
      expect(dec.packet.packetId).toBe(original.packetId);
      expect(dec.packet.senderHint).toBe(original.senderHint);
      expect(dec.packet.seqCounter).toBe(original.seqCounter);
      expect(dec.packet.triggerType).toBe(original.triggerType);
      expect(dec.packet.envPocketBag).toBe(original.envPocketBag);
      expect(dec.packet.sirenReq).toBe(original.sirenReq);
      expect(dec.packet.latitude).toBeCloseTo(original.latitude, 6);
      expect(dec.packet.longitude).toBeCloseTo(original.longitude, 6);
      expect(dec.packet.shortPayload).toBe(original.shortPayload);
    });
  });

  describe("F4: Ultrasonic FSK TX Boundaries", () => {
    it("T2-F4-1: frameForAcoustic throws on 55-byte or 57-byte input", () => {
      expect(() => frameForAcoustic(new Uint8Array(55))).toThrow();
      expect(() => frameForAcoustic(new Uint8Array(57))).toThrow();
    });

    it("T2-F4-2: native transmitUltrasonic rejection surfaces safely in useSonarMeshApp without crashing", async () => {
      setMockPlatform("android", 34);
      grantAllAndroidPermissions();
      mockNativeState.errors.transmitUltrasonic = new Error("AudioTrack busy");
      vi.resetModules();
      const hook = await mountUseSonarMeshApp();
      try {
        await expect(
          hook.run(async () => {
            await hook.state.sendUltrasonicPing();
          })
        ).resolves.toBeUndefined();
        expect(hook.state.toastMsg).toBeTruthy();
      } finally {
        await hook.unmount();
      }
    });

    it("T2-F4-3: rapid consecutive transmitUltrasonic calls do not crash when AudioContext is unavailable in Node", async () => {
      setMockPlatform("web", 0);
      vi.resetModules();
      const { sonarMeshBridge } = await import("@/native/sonarMeshBridge");
      const raw56 = encodeSmpV1(makeSamplePacket());
      await expect(
        Promise.all([
          sonarMeshBridge.transmitUltrasonic(raw56),
          sonarMeshBridge.transmitUltrasonic(raw56),
          sonarMeshBridge.transmitUltrasonic(raw56),
        ])
      ).resolves.toBeDefined();
    });

    it("T2-F4-4: custom symbolDurationMs=10 and 40 propagate cleanly to SonarMeshNative.startAcousticListen", async () => {
      setMockPlatform("android", 34);
      vi.resetModules();
      const { sonarMeshBridge } = await import("@/native/sonarMeshBridge");
      await sonarMeshBridge.startAcousticListen({
        ...DEFAULT_SONARMESH_SETTINGS,
        symbolDurationMs: 10,
      });
      expect(mockNativeState.lastAcousticConfig.symbolMs).toBe(10);

      await sonarMeshBridge.startAcousticListen({
        ...DEFAULT_SONARMESH_SETTINGS,
        symbolDurationMs: 40,
      });
      expect(mockNativeState.lastAcousticConfig.symbolMs).toBe(40);
    });

    it("T2-F4-5: UltrasonicModem.kt rejects non-56B arrays and restores STREAM_MUSIC volume in finally block", () => {
      const modemKt = fs.readFileSync(
        path.join(
          ROOT_DIR,
          "modules/sonarmesh-native/android/src/main/java/com/aryakhaslana/sonarmesh/audio/UltrasonicModem.kt"
        ),
        "utf8"
      );
      expect(modemKt).toContain("packet56.size != SmpV1Codec.PACKET_SIZE");
      expect(modemKt).toContain("Result.failure");
      expect(modemKt).toMatch(/finally\s*\{[\s\S]*?setStreamVolume/);
    });
  });

  describe("F5: On-Demand Ultrasonic RX & FFT Boundaries", () => {
    it("T2-F5-1: useSonarMeshApp.toggleAcousticListen blocks start when microphone permission is denied or blocked", async () => {
      setMockPlatform("android", 34);
      setMockPermission("android.permission.RECORD_AUDIO", "never_ask_again");
      vi.resetModules();
      const hook = await mountUseSonarMeshApp();
      try {
        await hook.run(async () => {
          await hook.state.toggleAcousticListen();
        });
        expect(hook.state.listening).toBe(false);
        expect(mockNativeState.listening).toBe(false);
        expect(hook.state.toastMsg).toBeTruthy();
      } finally {
        await hook.unmount();
      }
    });

    it("T2-F5-2: corrupted onPacketReceived Base64 or bad CRC is dropped without saving or triggering siren", async () => {
      setMockPlatform("android", 34);
      grantAllAndroidPermissions();
      vi.resetModules();
      const hook = await mountUseSonarMeshApp();
      try {
        const badRaw = encodeSmpV1(makeSamplePacket({ sirenReq: true }));
        badRaw[15] ^= 0xff; // corrupt CRC

        await hook.run(async () => {
          emitNativeEvent("onPacketReceived", {
            packetBase64: bytesToBase64(badRaw),
            transport: "ultrasonic",
            rssi: -50,
            relayed: false,
            snrDb: 10,
          });
        });
        expect(hook.state.packets).toHaveLength(0);
        expect(mockSqliteState.packets.size).toBe(0);
        expect(hook.state.sirenActive).toBe(false);
      } finally {
        await hook.unmount();
      }
    });

    it("T2-F5-3: bridge.detach() clears native event subscriptions and is idempotent", async () => {
      setMockPlatform("android", 34);
      vi.resetModules();
      const { sonarMeshBridge } = await import("@/native/sonarMeshBridge");
      sonarMeshBridge.attach({
        onPacket: () => {},
        onSpectrum: () => {},
        onCalibration: () => {},
        onImpact: () => {},
        onSensors: () => {},
        onError: () => {},
      });
      expect(getNativeListenerCount()).toBeGreaterThan(0);

      sonarMeshBridge.detach();
      expect(getNativeListenerCount()).toBe(0);
      expect(() => sonarMeshBridge.detach()).not.toThrow();
    });

    it("T2-F5-4: missing native module (null) falls back cleanly in sonarMeshBridge without throwing", async () => {
      setMockPlatform("android", 34);
      mockNativeState.moduleNull = true;
      vi.resetModules();
      const { sonarMeshBridge } = await import("@/native/sonarMeshBridge");
      expect(sonarMeshBridge.nativeAvailable).toBe(false);
      await expect(
        sonarMeshBridge.startAcousticListen(DEFAULT_SONARMESH_SETTINGS)
      ).resolves.toBe(true);
      await expect(sonarMeshBridge.stopAcousticListen()).resolves.toBeUndefined();
    });

    it("T2-F5-5: repeated start/stop acoustic listen leaves listening === false", async () => {
      setMockPlatform("android", 34);
      grantAllAndroidPermissions();
      vi.resetModules();
      const hook = await mountUseSonarMeshApp();
      try {
        await hook.run(async () => {
          await hook.state.toggleAcousticListen();
          await hook.state.toggleAcousticListen();
        });
        expect(hook.state.listening).toBe(false);
        expect(mockNativeState.listening).toBe(false);
      } finally {
        await hook.unmount();
      }
    });
  });

  describe("F6: 3-Second Noise Calibration Boundaries", () => {
    it("T2-F6-1: calibration requested when microphone permission is denied is blocked safely", async () => {
      setMockPlatform("android", 34);
      setMockPermission("android.permission.RECORD_AUDIO", "denied");
      vi.resetModules();
      const hook = await mountUseSonarMeshApp();
      try {
        await hook.run(async () => {
          await hook.state.calibrateNoiseFloor();
        });
        expect(hook.state.calibrating).toBe(false);
        expect(mockNativeState.calls.some((c) => c.method === "calibrateNoiseFloor")).toBe(false);
      } finally {
        await hook.unmount();
      }
    });

    it("T2-F6-2: calibration requested while not yet listening first starts acoustic listen when permitted", async () => {
      setMockPlatform("android", 34);
      grantAllAndroidPermissions();
      vi.resetModules();
      const hook = await mountUseSonarMeshApp();
      try {
        expect(hook.state.listening).toBe(false);
        await hook.run(async () => {
          await hook.state.calibrateNoiseFloor();
        });
        expect(mockNativeState.calls.some((c) => c.method === "startAcousticListen")).toBe(true);
        expect(mockNativeState.calls.some((c) => c.method === "calibrateNoiseFloor")).toBe(true);
      } finally {
        await hook.unmount();
      }
    });

    it("T2-F6-3: extreme negative and loud noiseFloorDb values propagate monotonically with thresholdDb > noiseFloorDb", async () => {
      setMockPlatform("android", 34);
      vi.resetModules();
      const { sonarMeshBridge } = await import("@/native/sonarMeshBridge");
      const results: Array<{ noiseFloorDb: number; thresholdDb: number }> = [];
      sonarMeshBridge.attach({
        onPacket: () => {},
        onSpectrum: () => {},
        onCalibration: (r) => results.push(r),
        onImpact: () => {},
        onSensors: () => {},
        onError: () => {},
      });

      emitNativeEvent("onCalibrationResult", { noiseFloorDb: -95, thresholdDb: -83.5 });
      emitNativeEvent("onCalibrationResult", { noiseFloorDb: -20, thresholdDb: -12.0 });
      expect(results[0].thresholdDb).toBeGreaterThan(results[0].noiseFloorDb);
      expect(results[1].thresholdDb).toBeGreaterThan(results[1].noiseFloorDb);
      expect(results[1].thresholdDb).toBeGreaterThan(results[0].thresholdDb);
      sonarMeshBridge.detach();
    });

    it("T2-F6-4: calibrateNoiseFloor(0) resolves without hanging timers after detach", async () => {
      vi.useFakeTimers();
      try {
        setMockPlatform("web", 0);
        vi.resetModules();
        const { sonarMeshBridge } = await import("@/native/sonarMeshBridge");
        const cb = vi.fn();
        sonarMeshBridge.attach({
          onPacket: () => {},
          onSpectrum: () => {},
          onCalibration: cb,
          onImpact: () => {},
          onSensors: () => {},
          onError: () => {},
        });
        await sonarMeshBridge.calibrateNoiseFloor(0);
        sonarMeshBridge.detach();
        await vi.advanceTimersByTimeAsync(10);
        expect(cb).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("T2-F6-5: UltrasonicModem.kt guards empty calibration samples against divide-by-zero / NaN", () => {
      const modemKt = fs.readFileSync(
        path.join(
          ROOT_DIR,
          "modules/sonarmesh-native/android/src/main/java/com/aryakhaslana/sonarmesh/audio/UltrasonicModem.kt"
        ),
        "utf8"
      );
      expect(modemKt).toMatch(/if\s*\(\s*\w+\.isEmpty\(\)\s*\)\s*0\.002/);
    });
  });

  describe("F7: ForegroundService Boundaries", () => {
    it("T2-F7-1: withSonarMeshAndroid plugin is idempotent across repeated invocations", async () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const plugin = require(path.join(ROOT_DIR, "plugins/withSonarMeshAndroid.js"));
      const configured = plugin({ name: "SonarMesh", slug: "solarpush-sonarmesh" });
      const modFn = configured.mods.android.manifest;
      const first = await modFn({
        modRequest: {},
        modResults: { manifest: { $: {}, application: [{ $: {} }] } },
      });
      const second = await modFn(first);

      expect(second.modResults.manifest["uses-feature"]).toHaveLength(5);
      expect(second.modResults.manifest.application[0].service).toHaveLength(1);
      expect(second.modResults.manifest.application[0].receiver).toHaveLength(1);
    });

    it("T2-F7-2: useSonarMeshApp blocks startMeshService when hasMeshBluetoothPermission is false", async () => {
      setMockPlatform("android", 34);
      // Only mic granted, bluetooth denied
      setMockPermission("android.permission.RECORD_AUDIO", "granted");
      vi.resetModules();
      const hook = await mountUseSonarMeshApp();
      try {
        await hook.run(async () => {
          await hook.state.toggleSos();
        });
        expect(mockNativeState.calls.some((c) => c.method === "startMeshService")).toBe(false);
      } finally {
        await hook.unmount();
      }
    });

    it("T2-F7-3: startMeshService rejecting with SecurityException leaves meshActive=false and bootStatus='ready'", async () => {
      setMockPlatform("android", 34);
      grantAllAndroidPermissions();
      mockNativeState.errors.startMeshService = new Error("SecurityException: FGS denied");
      vi.resetModules();
      const { packetStore } = await import("@/storage/packetStore");
      await (packetStore as unknown as { setOnboardingCompleted?: (v: boolean) => Promise<void> }).setOnboardingCompleted?.(true);

      const hook = await mountUseSonarMeshApp();
      try {
        expect(hook.state.bootStatus).toBe("ready");
        expect(hook.state.meshActive).toBe(false);
      } finally {
        await hook.unmount();
      }
    });

    it("T2-F7-4: isIgnoringBatteryOptimizations rejection returns false safely without throwing", async () => {
      setMockPlatform("android", 34);
      mockNativeState.errors.isIgnoringBatteryOptimizations = new Error("PowerManager unavailable");
      vi.resetModules();
      const { sonarMeshBridge } = await import("@/native/sonarMeshBridge");
      const fn = (sonarMeshBridge as unknown as {
        isIgnoringBatteryOptimizations?: () => Promise<boolean>;
      }).isIgnoringBatteryOptimizations;
      expect(typeof fn).toBe("function");
      await expect(fn!.call(sonarMeshBridge)).resolves.toBe(false);
    });

    it("T2-F7-5: app.json sets userInterfaceStyle to 'light' and uses light adaptiveIcon backgroundColor", () => {
      const appJson = JSON.parse(
        fs.readFileSync(path.join(ROOT_DIR, "app.json"), "utf8")
      ) as { expo: { userInterfaceStyle: string; android: { adaptiveIcon: { backgroundColor: string } } } };
      expect(appJson.expo.userInterfaceStyle).toBe("light");
      expect(appJson.expo.android.adaptiveIcon.backgroundColor.toUpperCase()).not.toBe("#0B0E11");
    });
  });

  describe("F8: BLE Advertising & Filtered Scanning Boundaries", () => {
    it("T2-F8-1: broadcastBle rejection with BluetoothAdapter disabled surfaces toastMsg safely", async () => {
      setMockPlatform("android", 34);
      grantAllAndroidPermissions();
      mockNativeState.errors.broadcastBlePacket = new Error("Bluetooth is turned off");
      vi.resetModules();
      const hook = await mountUseSonarMeshApp();
      try {
        await expect(
          hook.run(async () => {
            await hook.state.toggleSos();
          })
        ).resolves.toBeUndefined();
        expect(hook.state.toastMsg).toBeTruthy();
      } finally {
        await hook.unmount();
      }
    });

    it("T2-F8-2: duplicate BLE packet received twice via onPacketReceived is persisted once", async () => {
      setMockPlatform("android", 34);
      grantAllAndroidPermissions();
      vi.resetModules();
      const hook = await mountUseSonarMeshApp();
      try {
        const raw56 = encodeSmpV1(makeSamplePacket({ packetId: "9090909090909090" }));
        const b64 = bytesToBase64(raw56);

        await hook.run(async () => {
          emitNativeEvent("onPacketReceived", {
            packetBase64: b64,
            transport: "ble",
            rssi: -70,
            relayed: true,
            snrDb: 0,
          });
          emitNativeEvent("onPacketReceived", {
            packetBase64: b64,
            transport: "ble",
            rssi: -70,
            relayed: true,
            snrDb: 0,
          });
        });

        expect(hook.state.packets).toHaveLength(1);
        expect(mockSqliteState.packets.size).toBe(1);
      } finally {
        await hook.unmount();
      }
    });

    it("T2-F8-3: truncated or malformed BLE payload is dropped before packetStore.savePacket", async () => {
      setMockPlatform("android", 34);
      grantAllAndroidPermissions();
      vi.resetModules();
      const hook = await mountUseSonarMeshApp();
      try {
        await hook.run(async () => {
          emitNativeEvent("onPacketReceived", {
            packetBase64: bytesToBase64(new Uint8Array(20)),
            transport: "ble",
            rssi: -72,
            relayed: false,
            snrDb: 0,
          });
          emitNativeEvent("onPacketReceived", {
            packetBase64: bytesToBase64(new Uint8Array(57)),
            transport: "ble",
            rssi: -72,
            relayed: false,
            snrDb: 0,
          });
        });
        expect(hook.state.packets).toHaveLength(0);
        expect(mockSqliteState.packets.size).toBe(0);
      } finally {
        await hook.unmount();
      }
    });

    it("T2-F8-4: BleMeshTransport.kt handles null BluetoothAdapter/scanner/advertiser and evicts stale >15s fragments", () => {
      const bleKt = fs.readFileSync(
        path.join(
          ROOT_DIR,
          "modules/sonarmesh-native/android/src/main/java/com/aryakhaslana/sonarmesh/ble/BleMeshTransport.kt"
        ),
        "utf8"
      );
      expect(bleKt).toContain("Bluetooth adapter unavailable");
      expect(bleKt).toContain("BLE scanner unavailable");
      expect(bleKt).toContain("BLE advertiser not supported");
      expect(bleKt).toContain("15_000L");
    });

    it("T2-F8-5: API 30 grants mesh Bluetooth via location whereas API 31+ requires runtime Bluetooth grant", async () => {
      vi.resetModules();
      const perms = await import("@/permissions/androidPermissions");

      setMockPlatform("android", 30);
      setMockPermission("android.permission.ACCESS_FINE_LOCATION", "granted");
      const snap30 = await perms.getPermissionSnapshot();
      expect(perms.hasMeshBluetoothPermission(snap30)).toBe(true);

      setMockPlatform("android", 31);
      // Only location granted, BLUETOOTH_SCAN/ADVERTISE/CONNECT denied
      const snap31 = await perms.getPermissionSnapshot();
      expect(perms.hasMeshBluetoothPermission(snap31)).toBe(false);
    });
  });

  describe("F9: Multi-Trigger SOS & Pocket Detection Boundaries", () => {
    it("T2-F9-1: SensorTriggerManager.kt enforces impact >= impactThresholdMs2 and bridge impact triggers countdown", () => {
      const sensorKt = fs.readFileSync(
        path.join(
          ROOT_DIR,
          "modules/sonarmesh-native/android/src/main/java/com/aryakhaslana/sonarmesh/sensors/SensorTriggerManager.kt"
        ),
        "utf8"
      );
      expect(sensorKt).toContain("mag >= config.impactThresholdMs2");
      expect(sensorKt).toContain("5000L");
    });

    it("T2-F9-2: multiple rapid onImpactDetected events do not reset an already-running countdownSec", async () => {
      vi.useFakeTimers();
      try {
        setMockPlatform("android", 34);
        grantAllAndroidPermissions();
        vi.resetModules();
        const hook = await mountUseSonarMeshApp();
        try {
          await hook.run(async () => {
            emitNativeEvent("onImpactDetected", { magnitudeMs2: 33.0, isPocketBag: false });
          });
          const initial = hook.state.countdownSec;
          expect(initial).toBe(DEFAULT_SONARMESH_SETTINGS.sosCountdownSec);

          await React.act(async () => {
            await vi.advanceTimersByTimeAsync(2100);
          });
          const decremented = hook.state.countdownSec;
          expect(decremented).toBeLessThan(initial);

          await hook.run(async () => {
            emitNativeEvent("onImpactDetected", { magnitudeMs2: 38.0, isPocketBag: false });
          });
          expect(hook.state.countdownSec).toBe(decremented);
        } finally {
          await hook.unmount();
        }
      } finally {
        vi.useRealTimers();
      }
    });

    it("T2-F9-3: letting countdown reach 0 auto-activates sosActive and dispatches SENSOR_SOS with envPocketBag", async () => {
      vi.useFakeTimers();
      try {
        setMockPlatform("android", 34);
        grantAllAndroidPermissions();
        vi.resetModules();
        const { packetStore } = await import("@/storage/packetStore");
        await (packetStore as unknown as { updateSettings?: (s: Record<string, unknown>) => Promise<void> }).updateSettings?.({
          sosCountdownSec: 2,
        });

        const hook = await mountUseSonarMeshApp();
        try {
          await hook.run(async () => {
            emitNativeEvent("onSensorTelemetry", {
              accelMagnitudeMs2: 9.81,
              lightLux: 1.5,
              isPocketBag: true,
              headingDeg: 0,
            });
            emitNativeEvent("onImpactDetected", { magnitudeMs2: 35.0, isPocketBag: true });
          });

          await React.act(async () => {
            await vi.advanceTimersByTimeAsync(2500);
            await flushMicrotasks();
          });

          expect(hook.state.sosActive).toBe(true);
          const bleCall = mockNativeState.calls.find((c) => c.method === "broadcastBlePacket");
          expect(bleCall).toBeDefined();
          const dec = decodeSmpV1(base64ToBytes(String(bleCall!.args[0])));
          expect(dec.ok).toBe(true);
          if (dec.ok) {
            expect(dec.packet.triggerType).toBe("SENSOR_SOS");
            expect(dec.packet.envPocketBag).toBe(true);
          }
        } finally {
          await hook.unmount();
        }
      } finally {
        vi.useRealTimers();
      }
    });

    it("T2-F9-4: light sensor boundary lux <= 5.0 -> isPocketBag=true and lux > 5.0 -> false", () => {
      const sensorKt = fs.readFileSync(
        path.join(
          ROOT_DIR,
          "modules/sonarmesh-native/android/src/main/java/com/aryakhaslana/sonarmesh/sensors/SensorTriggerManager.kt"
        ),
        "utf8"
      );
      expect(sensorKt).toContain("isPocketBag = lux <= config.pocketLuxThreshold");
    });

    it("T2-F9-5: useSonarMeshApp.updateSettings persists updated thresholds and pushes to updateSensorConfig", async () => {
      setMockPlatform("android", 34);
      grantAllAndroidPermissions();
      vi.resetModules();
      const hook = await mountUseSonarMeshApp();
      try {
        await hook.run(async () => {
          await hook.state.updateSettings({
            impactThresholdMs2: 34,
            pocketLuxThreshold: 8,
            symbolDurationMs: 25,
          });
        });
        expect(mockNativeState.lastSensorConfig).toEqual({ impactMs2: 34, pocketLux: 8 });
        expect(hook.state.deviceState.settings.symbolDurationMs).toBe(25);
      } finally {
        await hook.unmount();
      }
    });
  });

  describe("F10: 3.5 kHz Rescue Siren Boundaries", () => {
    it("T2-F10-1: open-hand SOS (isPocketBag=false) with strong RSSI and sirenReq=false does not auto-start siren", async () => {
      setMockPlatform("android", 34);
      grantAllAndroidPermissions();
      vi.resetModules();
      const hook = await mountUseSonarMeshApp();
      try {
        await hook.run(async () => {
          await hook.state.toggleSos();
          emitNativeEvent("onSensorTelemetry", {
            accelMagnitudeMs2: 9.81,
            lightLux: 200,
            isPocketBag: false,
            headingDeg: 0,
          });
          const raw56 = encodeSmpV1(
            makeSamplePacket({ packetId: "2222111122221111", sirenReq: false })
          );
          emitNativeEvent("onPacketReceived", {
            packetBase64: bytesToBase64(raw56),
            transport: "ble",
            rssi: -50,
            relayed: false,
            snrDb: 0,
          });
        });
        expect(hook.state.sirenActive).toBe(false);
      } finally {
        await hook.unmount();
      }
    });

    it("T2-F10-2: pocketed SOS does not trigger siren at -69 dBm, and triggers at exact boundary -68 dBm", async () => {
      setMockPlatform("android", 34);
      grantAllAndroidPermissions();
      vi.resetModules();
      const hook = await mountUseSonarMeshApp();
      try {
        await hook.run(async () => {
          await hook.state.toggleSos();
          emitNativeEvent("onSensorTelemetry", {
            accelMagnitudeMs2: 9.81,
            lightLux: 1.0,
            isPocketBag: true,
            headingDeg: 0,
          });
          emitNativeEvent("onPacketReceived", {
            packetBase64: bytesToBase64(
              encodeSmpV1(makeSamplePacket({ packetId: "3333000033330001", senderHint: "a1000001", sirenReq: false }))
            ),
            transport: "ble",
            rssi: -69,
            relayed: false,
            snrDb: 0,
          });
        });
        expect(hook.state.sirenActive).toBe(false);

        await hook.run(async () => {
          emitNativeEvent("onPacketReceived", {
            packetBase64: bytesToBase64(
              encodeSmpV1(makeSamplePacket({ packetId: "3333000033330002", senderHint: "a1000002", sirenReq: false }))
            ),
            transport: "ble",
            rssi: -68,
            relayed: false,
            snrDb: 0,
          });
        });
        expect(hook.state.sirenActive).toBe(true);
      } finally {
        await hook.unmount();
      }
    });

    it("T2-F10-3: UltrasonicModem.kt startSiren wraps setStreamVolume inside try/catch against DND SecurityException", () => {
      const modemKt = fs.readFileSync(
        path.join(
          ROOT_DIR,
          "modules/sonarmesh-native/android/src/main/java/com/aryakhaslana/sonarmesh/audio/UltrasonicModem.kt"
        ),
        "utf8"
      );
      const startSirenSection = modemKt.slice(modemKt.indexOf("fun startSiren()"));
      expect(startSirenSection).toMatch(/try\s*\{[\s\S]*?setStreamVolume[\s\S]*?\}\s*catch/);
    });

    it("T2-F10-4: startSiren failure from native bridge keeps sirenActive=false and surfaces toastMsg", async () => {
      setMockPlatform("android", 34);
      grantAllAndroidPermissions();
      mockNativeState.errors.startSiren = new Error("AudioTrack init failed");
      vi.resetModules();
      const hook = await mountUseSonarMeshApp();
      try {
        await hook.run(async () => {
          await hook.state.toggleSiren();
        });
        expect(hook.state.sirenActive).toBe(false);
        expect(hook.state.toastMsg).toBeTruthy();
      } finally {
        await hook.unmount();
      }
    });

    it("T2-F10-5: stopping siren in Web/Node without AudioContext is an idempotent no-op", async () => {
      setMockPlatform("web", 0);
      vi.resetModules();
      const { sonarMeshBridge } = await import("@/native/sonarMeshBridge");
      await expect(sonarMeshBridge.stopSiren()).resolves.toBeUndefined();
      await expect(sonarMeshBridge.stopSiren()).resolves.toBeUndefined();
    });
  });

  describe("F11: Persistence & Geodesy Boundaries", () => {
    it("T2-F11-1: haversineMeters handles identical and antipodal points without NaN; estimateDistanceFromRssi clamps [0.4, 120]", () => {
      expect(haversineMeters(-7.25, 112.75, -7.25, 112.75)).toBe(0);
      const antipodal = haversineMeters(0, 0, 0, 180);
      expect(Number.isNaN(antipodal)).toBe(false);
      expect(antipodal).toBeGreaterThan(20_000_000);
      expect(estimateDistanceFromRssi(0)).toBe(0.5);
      expect(estimateDistanceFromRssi(-10)).toBe(0.4);
      expect(estimateDistanceFromRssi(-130)).toBe(120);
    });

    it("T2-F11-2: accuracyMetersToBucket and batteryPctToQuant clamp edge inputs accurately", () => {
      expect(accuracyMetersToBucket(null)).toBe(0);
      expect(accuracyMetersToBucket(undefined)).toBe(0);
      expect(accuracyMetersToBucket(-5)).toBe(0);
      expect(accuracyMetersToBucket(0)).toBe(0);
      expect(accuracyMetersToBucket(5)).toBe(1);
      expect(accuracyMetersToBucket(15)).toBe(2);
      expect(accuracyMetersToBucket(50)).toBe(3);
      expect(accuracyMetersToBucket(150)).toBe(4);
      expect(accuracyMetersToBucket(151)).toBe(5);
      expect(batteryPctToQuant(-10)).toBe(0);
      expect(batteryPctToQuant(150)).toBe(15);
    });

    it("T2-F11-3: corrupt JSON in kv_state/localStorage and corrupt Base64 packet rows do not throw", async () => {
      // Corrupt Web localStorage
      setMockPlatform("web", 0);
      window.localStorage.setItem("sonarmesh_state_v1", "{corrupt-json");
      vi.resetModules();
      const webStore = await import("@/storage/packetStore");
      const webState = (await webStore.packetStore.loadDeviceState()) as unknown as Record<string, unknown>;
      expect(webState.onboardingCompleted).toBe(false);

      // Corrupt Android SQLite rows
      setMockPlatform("android", 34);
      mockSqliteState.kv.set("device_state", "{broken-json");
      mockSqliteState.packets.set("bad1", {
        packet_id: "bad1",
        sender_hint: "0000",
        seq_counter: 1,
        raw_base64: "not-valid-base64!!!",
        transport: "ble",
        rssi: -70,
        snr_db: 0,
        relayed: 0,
        received_at_ms: Date.now(),
      });
      vi.resetModules();
      const androidStore = await import("@/storage/packetStore");
      const androidState = (await androidStore.packetStore.loadDeviceState()) as unknown as Record<string, unknown>;
      expect(androidState.onboardingCompleted).toBe(false);
      await expect(androidStore.packetStore.loadPackets()).resolves.toEqual([]);
    });

    it("T2-F11-4: native expo-sqlite openDatabaseAsync throwing falls back to in-memory persistence on Android", async () => {
      setMockPlatform("android", 34);
      mockSqliteState.openError = new Error("SQLite CantOpenException");
      vi.resetModules();
      const storeMod = await import("@/storage/packetStore");
      const ps = storeMod.packetStore as unknown as {
        loadDeviceState: () => Promise<Record<string, unknown>>;
        setOnboardingCompleted?: (v: boolean) => Promise<void>;
        savePacket: (r: unknown) => Promise<void>;
        loadPackets: () => Promise<unknown[]>;
      };

      const rec = storeMod.createRecordFromBytes(encodeSmpV1(makeSamplePacket()), {
        transport: "ble",
        rssi: -65,
        snrDb: 0,
        relayed: false,
      });
      await ps.savePacket(rec);
      expect(await ps.loadPackets()).toHaveLength(1);
      if (typeof ps.setOnboardingCompleted === "function") {
        await ps.setOnboardingCompleted(true);
        const st = await ps.loadDeviceState();
        expect(st.onboardingCompleted).toBe(true);
      }
    });

    it("T2-F11-5: locationService returns safe fallback coordinates when permission denied or expo-location throws", async () => {
      mockLocationState.permissionStatus = "denied";
      mockLocationState.error = new Error("Location service disabled");
      vi.resetModules();
      const locMod = (await import("@/services/locationService")) as Record<string, any>;
      const fn = locMod.getCurrentLocation ?? locMod.getOfflineSafeLocation ?? locMod.fetchDeviceLocation;
      expect(typeof fn).toBe("function");
      const res = await fn();
      expect(res.isFallback).toBe(true);
      expect(typeof (res.lat ?? res.latitude)).toBe("number");
      expect(typeof (res.lon ?? res.longitude)).toBe("number");
    });
  });

  describe("F13: Startup Safety & Permission Guarding Boundaries", () => {
    it("T2-F13-1: useSonarMeshApp survives packetStore and permission errors on boot without unhandled rejection", async () => {
      setMockPlatform("android", 34);
      mockSqliteState.openError = new Error("SQLite failed");
      mockOsState.permissionError = new Error("PermissionsAndroid unavailable");
      vi.resetModules();
      const hook = await mountUseSonarMeshApp();
      try {
        expect(["ready", "error"]).toContain(hook.state.bootStatus);
      } finally {
        await hook.unmount();
      }
    });

    it("T2-F13-2: PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN maps to 'blocked' in androidPermissions", async () => {
      setMockPlatform("android", 34);
      setMockPermission("android.permission.RECORD_AUDIO", "never_ask_again");
      vi.resetModules();
      const perms = await import("@/permissions/androidPermissions");
      const result = await perms.requestPermission("microphone");
      expect(result).toBe("blocked");
    });

    it("T2-F13-3: API boundary checks across API 26, API 30, and API 33", async () => {
      vi.resetModules();
      const perms = await import("@/permissions/androidPermissions");

      setMockPlatform("android", 26);
      setMockPermission("android.permission.ACCESS_FINE_LOCATION", "granted");
      const snap26 = await perms.getPermissionSnapshot();
      expect(snap26.notifications).toBe("granted"); // Not required runtime permission < API 33
      expect(perms.hasMeshBluetoothPermission(snap26)).toBe(true);

      setMockPlatform("android", 30);
      const snap30 = await perms.getPermissionSnapshot();
      expect(perms.hasMeshBluetoothPermission(snap30)).toBe(true);

      setMockPlatform("android", 33);
      // POST_NOTIFICATIONS & BLUETOOTH_* still denied
      const snap33 = await perms.getPermissionSnapshot();
      expect(snap33.notifications).toBe("denied");
      expect(perms.hasMeshBluetoothPermission(snap33)).toBe(false);
    });

    it("T2-F13-4: onNativeError event surfaces non-fatal toastMsg without crashing bootStatus", async () => {
      setMockPlatform("android", 34);
      grantAllAndroidPermissions();
      vi.resetModules();
      const hook = await mountUseSonarMeshApp();
      try {
        await hook.run(async () => {
          emitNativeEvent("onNativeError", {
            source: "ble",
            message: "BLE scan throttled by OS",
          });
        });
        expect(hook.state.bootStatus).toBe("ready");
        expect(String(hook.state.toastMsg)).toContain("BLE scan throttled");
      } finally {
        await hook.unmount();
      }
    });

    it("T2-F13-5: sonarmesh-native module handles missing native module and EventEmitter errors safely at import time", async () => {
      setMockPlatform("android", 34);
      mockNativeState.moduleNull = true;
      vi.resetModules();
      const mod = await import("sonarmesh-native");
      expect(mod.SonarMeshNative).toBeNull();
      expect(mod.isNativeAndroidModuleAvailable).toBe(false);
      expect(() => mod.createNativeEventEmitter()).not.toThrow();
      expect(mod.createNativeEventEmitter()).toBeNull();

      // Verify source guards requireOptionalNativeModule and avoids unsafe EventEmitter constructor
      const indexSrc = fs.readFileSync(
        path.join(ROOT_DIR, "modules/sonarmesh-native/src/index.ts"),
        "utf8"
      );
      expect(indexSrc).toMatch(/try\s*\{[\s\S]*?requireOptionalNativeModule/);
      expect(indexSrc).not.toContain("new EventEmitter(");
    });
  });
});
