import fs from "node:fs";
import path from "node:path";
import React from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SONARMESH_SETTINGS, SONARMESH_CONSTANTS } from "@/config/sonarmeshConfig";
import {
  accuracyMetersToBucket,
  batteryPctToQuant,
  batteryQuantToPct,
  bearingDegrees,
  cardinalDirectionId,
  estimateDistanceFromRssi,
  formatAgeId,
  formatDistance,
  gpsAccuracyBucketLabel,
  haversineMeters,
  relativeBearing,
} from "@/protocol/geo";
import {
  PacketDeduplicator,
  SMPV1_ACOUSTIC_PREAMBLE,
  SMPV1_FRAMED_SIZE,
  SMPV1_MAGIC_VER,
  SMPV1_PACKET_SIZE,
  SMPV1_SYNC_WORD,
  base64ToBytes,
  bytesToBase64,
  crc16CcittFalse,
  decodeSmpV1,
  encodeSmpV1,
  frameForAcoustic,
  prepareRelayPacket,
  type SmpV1Packet,
  type TriggerType,
} from "@/protocol/smpv1";
import {
  emitNativeEvent,
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
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await React.act(async () => {
      await new Promise((r) => setTimeout(r, stepMs));
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

describe("Tier 1 Core E2E (F1-F11, F13)", () => {
  describe("F1: SMPv1 56-byte Big-Endian Codec", () => {
    it("T1-F1-1: encodeSmpV1 produces exact 56 bytes with MAGIC_VER 0x51 and Big-Endian fields", () => {
      const raw = encodeSmpV1(
        makeSamplePacket({
          triggerType: "SENSOR_SOS",
          envPocketBag: true,
          sirenReq: true,
          ttl: 4,
          seqCounter: 0x1234,
          latitude: -7.257472,
          longitude: 112.752088,
          ageSec: 0x0506,
          powNonce: 0x0708,
        })
      );

      expect(raw.length).toBe(56);
      expect(raw[0]).toBe(0x51);
      // FLAGS_TTL: (1<<6) | (1<<5) | (1<<4) | 4 = 0x74
      expect(raw[1]).toBe(0x74);
      // Big-Endian SEQ_COUNTER [10..11]
      expect(raw[10]).toBe(0x12);
      expect(raw[11]).toBe(0x34);
      // Big-Endian LATITUDE [12..15] & LONGITUDE [16..19]
      const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
      expect(view.getInt32(12, false)).toBe(Math.round(-7.257472 * 1e7));
      expect(view.getInt32(16, false)).toBe(Math.round(112.752088 * 1e7));
      // Big-Endian AGE_SEC [21..22] & POW_NONCE [27..28]
      expect(raw[21]).toBe(0x05);
      expect(raw[22]).toBe(0x06);
      expect(raw[27]).toBe(0x07);
      expect(raw[28]).toBe(0x08);
      // Big-Endian CRC16 [54..55]
      expect(view.getUint16(54, false)).toBe(crc16CcittFalse(raw, 0, 54));
    });

    it("T1-F1-2: round-trip encodeSmpV1 -> decodeSmpV1 preserves all 4 TriggerType values and packet fields", () => {
      const triggers: TriggerType[] = ["MANUAL", "SENSOR_SOS", "DAILY_RADAR", "WITNESS_PIN"];
      for (const triggerType of triggers) {
        const pkt = makeSamplePacket({
          triggerType,
          envPocketBag: triggerType === "SENSOR_SOS",
          sirenReq: triggerType === "MANUAL",
          ttl: 9,
          shortPayload: `TRG_${triggerType.slice(0, 4)}`,
        });
        const raw = encodeSmpV1(pkt);
        const decoded = decodeSmpV1(raw);
        expect(decoded.ok).toBe(true);
        if (!decoded.ok) continue;

        expect(decoded.packet.triggerType).toBe(triggerType);
        expect(decoded.packet.envPocketBag).toBe(pkt.envPocketBag);
        expect(decoded.packet.sirenReq).toBe(pkt.sirenReq);
        expect(decoded.packet.ttl).toBe(9);
        expect(decoded.packet.packetId).toBe(pkt.packetId);
        expect(decoded.packet.seqCounter).toBe(pkt.seqCounter);
        expect(decoded.packet.latitude).toBeCloseTo(pkt.latitude, 6);
        expect(decoded.packet.longitude).toBeCloseTo(pkt.longitude, 6);
        expect(decoded.packet.shortPayload).toBe(pkt.shortPayload.slice(0, 9));
        expect(decoded.packet.authSig128Hex).toMatch(/^[0-9a-f]{32}$/);
      }
    });

    it("T1-F1-3: crc16CcittFalse matches standard check value 0x29B1 for '123456789' and validates bytes 0..53", () => {
      const vec = new Uint8Array([0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39]);
      expect(crc16CcittFalse(vec)).toBe(0x29b1);

      const raw = encodeSmpV1(makeSamplePacket());
      const view = new DataView(raw.buffer);
      expect(crc16CcittFalse(raw, 0, 54)).toBe(view.getUint16(54, false));
    });

    it("T1-F1-4: bytesToBase64 <-> base64ToBytes round-trips arbitrary 56B binary packets without btoa/atob/Buffer/TextEncoder", () => {
      const g = globalThis as Record<string, unknown>;
      const origBtoa = g.btoa;
      const origAtob = g.atob;
      const origBuffer = g.Buffer;
      const origTextEncoder = g.TextEncoder;
      const origTextDecoder = g.TextDecoder;

      try {
        delete g.btoa;
        delete g.atob;
        delete g.Buffer;
        delete g.TextEncoder;
        delete g.TextDecoder;

        const bytes = encodeSmpV1(
          makeSamplePacket({ shortPayload: "DARURAT", powNonce: 65000 })
        );
        const b64 = bytesToBase64(bytes);
        const back = base64ToBytes(b64);
        expect(Array.from(back)).toEqual(Array.from(bytes));
        const dec = decodeSmpV1(back);
        expect(dec.ok).toBe(true);
        if (dec.ok) {
          expect(dec.packet.shortPayload).toBe("DARURAT");
        }
      } finally {
        g.btoa = origBtoa;
        g.atob = origAtob;
        g.Buffer = origBuffer;
        g.TextEncoder = origTextEncoder;
        g.TextDecoder = origTextDecoder;
      }
    });

    it("T1-F1-5: SmpV1Codec.kt layout constants match TypeScript SMPv1 constants byte-for-byte", () => {
      const ktPath = path.join(
        ROOT_DIR,
        "modules/sonarmesh-native/android/src/main/java/com/aryakhaslana/sonarmesh/protocol/SmpV1Codec.kt"
      );
      const kt = fs.readFileSync(ktPath, "utf8");
      expect(kt).toContain(`const val PACKET_SIZE = ${SMPV1_PACKET_SIZE}`);
      expect(kt).toContain(`const val MAGIC_VER: Byte = 0x${SMPV1_MAGIC_VER.toString(16)}`);
      expect(kt).toContain(`const val SYNC_WORD: Int = 0x${SMPV1_SYNC_WORD.toString(16).toUpperCase()}`);
      expect(kt).toContain("ByteOrder.BIG_ENDIAN");
    });
  });

  describe("F2: Deduplication & Anti-Replay", () => {
    it("T1-F2-1: accepts first packet and rejects identical packetId within DEDUP_WINDOW_MS", () => {
      const dedup = new PacketDeduplicator(512, SONARMESH_CONSTANTS.DEDUP_WINDOW_MS);
      const pkt = makeSamplePacket({ packetId: "1111222233334444", seqCounter: 1 });
      expect(dedup.acceptIfFresh(pkt, 10_000)).toBe(true);
      expect(dedup.acceptIfFresh(pkt, 10_000 + SONARMESH_CONSTANTS.DEDUP_WINDOW_MS - 1)).toBe(false);
    });

    it("T1-F2-2: accepts higher seqCounter (N+1) with new packetId from same senderHint", () => {
      const dedup = new PacketDeduplicator();
      expect(
        dedup.acceptIfFresh(
          makeSamplePacket({ senderHint: "aaaa1111", packetId: "0000000000000001", seqCounter: 10 }),
          1000
        )
      ).toBe(true);
      expect(
        dedup.acceptIfFresh(
          makeSamplePacket({ senderHint: "aaaa1111", packetId: "0000000000000002", seqCounter: 11 }),
          2000
        )
      ).toBe(true);
    });

    it("T1-F2-3: tracks highestSeq independently per senderHint", () => {
      const dedup = new PacketDeduplicator();
      expect(
        dedup.acceptIfFresh(
          makeSamplePacket({ senderHint: "aaaa0001", packetId: "1000000000000001", seqCounter: 500 }),
          1000
        )
      ).toBe(true);
      expect(
        dedup.acceptIfFresh(
          makeSamplePacket({ senderHint: "bbbb0002", packetId: "2000000000000001", seqCounter: 1 }),
          2000
        )
      ).toBe(true);
    });

    it("T1-F2-4: hydrateSeen restores persisted packetId + highestSeq across simulated cold restart", () => {
      const dedup = new PacketDeduplicator();
      dedup.hydrateSeen([
        {
          packetId: "cafebabedeadbeef",
          senderHint: "12345678",
          seqCounter: 50,
          seenAtMs: 50_000,
        },
      ]);

      expect(
        dedup.acceptIfFresh(
          makeSamplePacket({ packetId: "cafebabedeadbeef", senderHint: "12345678", seqCounter: 51 }),
          60_000
        )
      ).toBe(false);
      expect(
        dedup.acceptIfFresh(
          makeSamplePacket({ packetId: "0000000000000099", senderHint: "12345678", seqCounter: 49 }),
          60_000
        )
      ).toBe(false);
      expect(
        dedup.acceptIfFresh(
          makeSamplePacket({ packetId: "0000000000000100", senderHint: "12345678", seqCounter: 51 }),
          60_000
        )
      ).toBe(true);
    });

    it("T1-F2-5: clear() resets seen and highestSeq caches", () => {
      const dedup = new PacketDeduplicator();
      const pkt = makeSamplePacket({ packetId: "fedcba9876543210", senderHint: "88889999", seqCounter: 80 });
      expect(dedup.acceptIfFresh(pkt, 1000)).toBe(true);
      expect(dedup.acceptIfFresh(pkt, 2000)).toBe(false);

      dedup.clear();
      expect(dedup.acceptIfFresh(pkt, 3000)).toBe(true);
    });
  });

  describe("F3: Multi-Hop TTL & Relay Prep", () => {
    it("T1-F3-1: prepareRelayPacket decrements ttl, increments ageSec, recomputes CRC16, returns 56 valid bytes", () => {
      const pkt = makeSamplePacket({ ttl: 5, ageSec: 12 });
      const relayed = prepareRelayPacket(pkt, 5);
      expect(relayed).not.toBeNull();
      expect(relayed!.length).toBe(56);

      const dec = decodeSmpV1(relayed!);
      expect(dec.ok).toBe(true);
      if (!dec.ok) return;
      expect(dec.packet.ttl).toBe(4);
      expect(dec.packet.ageSec).toBe(17);
    });

    it("T1-F3-2: multi-hop chain (TTL 4 -> 3 -> 2 -> 1) stays decodable and stops at ttl === 1", () => {
      let current = makeSamplePacket({ ttl: 4, ageSec: 0 });
      const ttls: number[] = [];
      for (let i = 0; i < 3; i++) {
        const nextBytes = prepareRelayPacket(current, 2);
        expect(nextBytes).not.toBeNull();
        const dec = decodeSmpV1(nextBytes!);
        expect(dec.ok).toBe(true);
        if (!dec.ok) return;
        ttls.push(dec.packet.ttl);
        current = dec.packet;
      }
      expect(ttls).toEqual([3, 2, 1]);
      expect(prepareRelayPacket(current, 2)).toBeNull();
    });

    it("T1-F3-3: SONARMESH_CONSTANTS defines relay jitter bounds 200..2000ms and defaultTtl=5", () => {
      expect(SONARMESH_CONSTANTS.RELAY_JITTER_MIN_MS).toBe(200);
      expect(SONARMESH_CONSTANTS.RELAY_JITTER_MAX_MS).toBe(2000);
      expect(DEFAULT_SONARMESH_SETTINGS.defaultTtl).toBe(5);
    });

    it("T1-F3-4: BleMeshTransport.kt calls SmpV1Codec.prepareRelay with 200..2000ms jitter", () => {
      const bleKt = fs.readFileSync(
        path.join(
          ROOT_DIR,
          "modules/sonarmesh-native/android/src/main/java/com/aryakhaslana/sonarmesh/ble/BleMeshTransport.kt"
        ),
        "utf8"
      );
      expect(bleKt).toContain("SmpV1Codec.prepareRelay");
      expect(bleKt).toContain("Random.nextLong(200L, 2001L)");
    });

    it("T1-F3-5: useSonarMeshApp relays valid inbound ttl >= 2 packet when running in non-native loopback", async () => {
      vi.useFakeTimers();
      try {
        setMockPlatform("web", 0);
        grantAllAndroidPermissions();
        vi.resetModules();
        const { packetStore } = await import("@/storage/packetStore");
        await packetStore.saveDeviceState({
          senderHint: "01020304",
          seqCounter: 1,
          lastLatitude: -7.25,
          lastLongitude: 112.75,
          lastAccuracyM: 10,
          onboardingCompleted: true,
          settings: { ...DEFAULT_SONARMESH_SETTINGS },
        } as never);

        const { sonarMeshBridge } = await import("@/native/sonarMeshBridge");
        const broadcastSpy = vi.spyOn(sonarMeshBridge, "broadcastBle");

        const hook = await mountUseSonarMeshApp();
        try {
          const pktBytes = encodeSmpV1(
            makeSamplePacket({ packetId: "aa11bb22cc33dd44", senderHint: "99887766", ttl: 3 })
          );
          await hook.run(async () => {
            sonarMeshBridge.injectSimulatedInboundPacket(-7.25, 112.75, "ble", {
              packetId: "aa11bb22cc33dd44",
              senderHint: "99887766",
              ttl: 3,
            });
          });

          await React.act(async () => {
            await vi.advanceTimersByTimeAsync(2200);
          });

          expect(pktBytes.length).toBe(56);
          expect(broadcastSpy).toHaveBeenCalled();
        } finally {
          await hook.unmount();
        }
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("F4: Ultrasonic FSK TX (AudioTrack)", () => {
    it("T1-F4-1: frameForAcoustic outputs 60 bytes prefixed with 0xAA 0xAA 0x2D 0xD4", () => {
      const raw56 = encodeSmpV1(makeSamplePacket());
      const framed = frameForAcoustic(raw56);
      expect(framed.length).toBe(SMPV1_FRAMED_SIZE);
      expect(Array.from(framed.subarray(0, 4))).toEqual(Array.from(SMPV1_ACOUSTIC_PREAMBLE));
      expect(Array.from(framed.subarray(4))).toEqual(Array.from(raw56));
    });

    it("T1-F4-2: DEFAULT_SONARMESH_SETTINGS configures 18.5-20 kHz FSK defaults and 48 kHz sample rate", () => {
      expect(DEFAULT_SONARMESH_SETTINGS.freqSpace0Hz).toBe(18750);
      expect(DEFAULT_SONARMESH_SETTINGS.freqMark1Hz).toBe(19500);
      expect(DEFAULT_SONARMESH_SETTINGS.symbolDurationMs).toBe(20);
      expect(SONARMESH_CONSTANTS.SAMPLE_RATE_HZ).toBe(48000);
    });

    it("T1-F4-3: on Android, sonarMeshBridge.transmitUltrasonic encodes Base64 and invokes SonarMeshNative.transmitUltrasonic", async () => {
      setMockPlatform("android", 34);
      vi.resetModules();
      const { sonarMeshBridge } = await import("@/native/sonarMeshBridge");
      const raw56 = encodeSmpV1(makeSamplePacket());
      await sonarMeshBridge.transmitUltrasonic(raw56);

      const txCall = mockNativeState.calls.find((c) => c.method === "transmitUltrasonic");
      expect(txCall).toBeDefined();
      expect(txCall!.args[0]).toBe(bytesToBase64(raw56));
    });

    it("T1-F4-4: on Web preview, sonarMeshBridge.transmitUltrasonic completes safely without native module", async () => {
      setMockPlatform("web", 0);
      vi.resetModules();
      const { sonarMeshBridge } = await import("@/native/sonarMeshBridge");
      expect(sonarMeshBridge.nativeAvailable).toBe(false);
      await expect(
        sonarMeshBridge.transmitUltrasonic(encodeSmpV1(makeSamplePacket()))
      ).resolves.toBe(true);
    });

    it("T1-F4-5: useSonarMeshApp.sendUltrasonicPing transmits framed SOS packet cleanly", async () => {
      setMockPlatform("android", 34);
      grantAllAndroidPermissions();
      vi.resetModules();
      const hook = await mountUseSonarMeshApp();
      try {
        await hook.run(async () => {
          await hook.state.sendUltrasonicPing();
        });
        const txCall = mockNativeState.calls.find((c) => c.method === "transmitUltrasonic");
        expect(txCall).toBeDefined();
      } finally {
        await hook.unmount();
      }
    });
  });

  describe("F5: On-Demand Ultrasonic RX & FFT", () => {
    it("T1-F5-1: sonarMeshBridge.startAcousticListen forwards FSK settings to SonarMeshNative on Android", async () => {
      setMockPlatform("android", 34);
      vi.resetModules();
      const { sonarMeshBridge } = await import("@/native/sonarMeshBridge");
      await sonarMeshBridge.startAcousticListen({
        ...DEFAULT_SONARMESH_SETTINGS,
        freqSpace0Hz: 18600,
        freqMark1Hz: 19400,
        symbolDurationMs: 25,
      });

      expect(mockNativeState.listening).toBe(true);
      expect(mockNativeState.lastAcousticConfig).toEqual({
        freqSpace0Hz: 18600,
        freqMark1Hz: 19400,
        symbolMs: 25,
      });
    });

    it("T1-F5-2: sonarMeshBridge.stopAcousticListen invokes SonarMeshNative.stopAcousticListen", async () => {
      setMockPlatform("android", 34);
      vi.resetModules();
      const { sonarMeshBridge } = await import("@/native/sonarMeshBridge");
      await sonarMeshBridge.startAcousticListen(DEFAULT_SONARMESH_SETTINGS);
      await sonarMeshBridge.stopAcousticListen();
      expect(mockNativeState.listening).toBe(false);
      expect(mockNativeState.calls.some((c) => c.method === "stopAcousticListen")).toBe(true);
    });

    it("T1-F5-3: native onSpectrumFrame and onPacketReceived propagate through sonarMeshBridge.attach", async () => {
      setMockPlatform("android", 34);
      vi.resetModules();
      const { sonarMeshBridge } = await import("@/native/sonarMeshBridge");
      const receivedPackets: unknown[] = [];
      const receivedFrames: unknown[] = [];

      sonarMeshBridge.attach({
        onPacket: (ev) => receivedPackets.push(ev),
        onSpectrum: (f) => receivedFrames.push(f),
        onCalibration: () => {},
        onImpact: () => {},
        onSensors: () => {},
        onError: () => {},
      });

      const raw56 = encodeSmpV1(makeSamplePacket({ shortPayload: "AUDIO RX" }));
      emitNativeEvent("onSpectrumFrame", {
        startFreqHz: 18200,
        endFreqHz: 20200,
        binsDb: [-55, -42, -30],
        peakFreqHz: 19500,
        noiseFloorDb: -55,
        snrDb: 25,
      });
      emitNativeEvent("onPacketReceived", {
        packetBase64: bytesToBase64(raw56),
        transport: "ultrasonic",
        rssi: -55,
        relayed: false,
        snrDb: 19.2,
      });

      expect(receivedFrames).toHaveLength(1);
      expect(receivedPackets).toHaveLength(1);
      sonarMeshBridge.detach();
    });

    it("T1-F5-4: Web preview startAcousticListen emits 18200..20200 Hz spectrum frames and stops cleanly", async () => {
      vi.useFakeTimers();
      try {
        setMockPlatform("web", 0);
        vi.resetModules();
        const { sonarMeshBridge } = await import("@/native/sonarMeshBridge");
        const frames: Array<{ startFreqHz: number; endFreqHz: number; binsDb: number[] }> = [];

        sonarMeshBridge.attach({
          onPacket: () => {},
          onSpectrum: (f) => frames.push(f),
          onCalibration: () => {},
          onImpact: () => {},
          onSensors: () => {},
          onError: () => {},
        });

        await sonarMeshBridge.startAcousticListen(DEFAULT_SONARMESH_SETTINGS);
        await vi.advanceTimersByTimeAsync(220);
        expect(frames.length).toBeGreaterThanOrEqual(2);
        expect(frames[0].startFreqHz).toBe(18200);
        expect(frames[0].endFreqHz).toBe(20200);
        expect(frames[0].binsDb.length).toBe(40);

        const countAtStop = frames.length;
        await sonarMeshBridge.stopAcousticListen();
        await vi.advanceTimersByTimeAsync(250);
        expect(frames.length).toBe(countAtStop);
        sonarMeshBridge.detach();
      } finally {
        vi.useRealTimers();
      }
    });

    it("T1-F5-5: useSonarMeshApp.toggleAcousticListen starts listening when mic permission granted and updates state", async () => {
      setMockPlatform("android", 34);
      grantAllAndroidPermissions();
      vi.resetModules();
      const hook = await mountUseSonarMeshApp();
      try {
        expect(hook.state.listening).toBe(false);
        await hook.run(async () => {
          await hook.state.toggleAcousticListen();
        });
        expect(hook.state.listening).toBe(true);
        expect(mockNativeState.listening).toBe(true);

        await hook.run(async () => {
          await hook.state.toggleAcousticListen();
        });
        expect(hook.state.listening).toBe(false);
      } finally {
        await hook.unmount();
      }
    });
  });

  describe("F6: 3-Second Noise-Floor Calibration", () => {
    it("T1-F6-1: SONARMESH_CONSTANTS.CALIBRATION_DURATION_MS equals 3000", () => {
      expect(SONARMESH_CONSTANTS.CALIBRATION_DURATION_MS).toBe(3000);
    });

    it("T1-F6-2: sonarMeshBridge.calibrateNoiseFloor passes 3000 ms to SonarMeshNative on Android", async () => {
      setMockPlatform("android", 34);
      vi.resetModules();
      const { sonarMeshBridge } = await import("@/native/sonarMeshBridge");
      await sonarMeshBridge.calibrateNoiseFloor();
      const call = mockNativeState.calls.find((c) => c.method === "calibrateNoiseFloor");
      expect(call?.args[0]).toBe(3000);
    });

    it("T1-F6-3: onCalibrationResult event delivers { noiseFloorDb, thresholdDb } to bridge onCalibration callback", async () => {
      setMockPlatform("android", 34);
      vi.resetModules();
      const { sonarMeshBridge } = await import("@/native/sonarMeshBridge");
      let calRes: { noiseFloorDb: number; thresholdDb: number } | null = null;
      sonarMeshBridge.attach({
        onPacket: () => {},
        onSpectrum: () => {},
        onCalibration: (res) => {
          calRes = res;
        },
        onImpact: () => {},
        onSensors: () => {},
        onError: () => {},
      });

      emitNativeEvent("onCalibrationResult", { noiseFloorDb: -56.4, thresholdDb: -44.2 });
      expect(calRes).not.toBeNull();
      expect(calRes!.thresholdDb).toBeGreaterThan(calRes!.noiseFloorDb);
      sonarMeshBridge.detach();
    });

    it("T1-F6-4: Web preview calibrateNoiseFloor completes asynchronously and emits calibrated noiseFloorDb/thresholdDb", async () => {
      vi.useFakeTimers();
      try {
        setMockPlatform("web", 0);
        vi.resetModules();
        const { sonarMeshBridge } = await import("@/native/sonarMeshBridge");
        let calRes: { noiseFloorDb: number; thresholdDb: number } | null = null;
        sonarMeshBridge.attach({
          onPacket: () => {},
          onSpectrum: () => {},
          onCalibration: (res) => {
            calRes = res;
          },
          onImpact: () => {},
          onSensors: () => {},
          onError: () => {},
        });

        await sonarMeshBridge.calibrateNoiseFloor(50);
        await vi.advanceTimersByTimeAsync(60);
        expect(calRes).not.toBeNull();
        expect(calRes!.thresholdDb).toBeGreaterThan(calRes!.noiseFloorDb);
        sonarMeshBridge.detach();
      } finally {
        vi.useRealTimers();
      }
    });

    it("T1-F6-5: useSonarMeshApp.calibrateNoiseFloor sets calibrating=true and updates noiseFloorDb & thresholdDb", async () => {
      setMockPlatform("android", 34);
      grantAllAndroidPermissions();
      vi.resetModules();
      const hook = await mountUseSonarMeshApp();
      try {
        await hook.run(async () => {
          await hook.state.calibrateNoiseFloor();
        });
        expect(hook.state.calibrating).toBe(true);

        await hook.run(async () => {
          emitNativeEvent("onCalibrationResult", { noiseFloorDb: -58.0, thresholdDb: -45.5 });
        });
        expect(hook.state.calibrating).toBe(false);
        expect(hook.state.noiseFloorDb).toBeCloseTo(-58.0, 1);
        expect(hook.state.thresholdDb).toBeCloseTo(-45.5, 1);
      } finally {
        await hook.unmount();
      }
    });
  });

  describe("F7: ForegroundService (connectedDevice | microphone)", () => {
    it("T1-F7-1: app.json declares required FGS, notifications, battery optimization, and wake lock permissions", () => {
      const appJson = JSON.parse(
        fs.readFileSync(path.join(ROOT_DIR, "app.json"), "utf8")
      ) as { expo: { android: { permissions: string[] } } };
      const perms = appJson.expo.android.permissions;
      expect(perms).toContain("android.permission.FOREGROUND_SERVICE");
      expect(perms).toContain("android.permission.FOREGROUND_SERVICE_CONNECTED_DEVICE");
      expect(perms).toContain("android.permission.FOREGROUND_SERVICE_MICROPHONE");
      expect(perms).toContain("android.permission.POST_NOTIFICATIONS");
      expect(perms).toContain("android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS");
      expect(perms).toContain("android.permission.WAKE_LOCK");
    });

    it("T1-F7-2: withSonarMeshAndroid config plugin injects SonarMeshForegroundService and BleScanResultReceiver", async () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const plugin = require(path.join(ROOT_DIR, "plugins/withSonarMeshAndroid.js"));
      const configured = plugin({ name: "SonarMesh", slug: "solarpush-sonarmesh" });
      const manifestMod = configured.mods.android.manifest;
      const result = await manifestMod({
        modRequest: {},
        modResults: { manifest: { $: {}, application: [{ $: {} }] } },
      });
      const app = result.modResults.manifest.application[0];
      expect(app.service).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            $: expect.objectContaining({
              "android:name": "com.aryakhaslana.sonarmesh.ble.SonarMeshForegroundService",
              "android:exported": "false",
              "android:foregroundServiceType": "connectedDevice|microphone",
            }),
          }),
        ])
      );
      expect(app.receiver).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            $: expect.objectContaining({
              "android:name": "com.aryakhaslana.sonarmesh.ble.BleScanResultReceiver",
              "android:exported": "false",
            }),
          }),
        ])
      );
    });

    it("T1-F7-3: module AndroidManifest.xml declares API <= 30 BLUETOOTH and BLUETOOTH_ADMIN alongside API 31+ permissions", () => {
      const manifest = fs.readFileSync(
        path.join(ROOT_DIR, "modules/sonarmesh-native/android/src/main/AndroidManifest.xml"),
        "utf8"
      );
      expect(manifest).toContain("android.permission.BLUETOOTH\"");
      expect(manifest).toContain("android.permission.BLUETOOTH_ADMIN\"");
      expect(manifest).toContain("maxSdkVersion=\"30\"");
      expect(manifest).toContain("android.permission.BLUETOOTH_SCAN");
    });

    it("T1-F7-4: sonarMeshBridge.startMesh configures sensors and calls startMeshService, and stopMesh stops service", async () => {
      setMockPlatform("android", 34);
      vi.resetModules();
      const { sonarMeshBridge } = await import("@/native/sonarMeshBridge");
      await sonarMeshBridge.startMesh("SOS", true, DEFAULT_SONARMESH_SETTINGS);

      expect(mockNativeState.serviceRunning).toBe(true);
      expect(mockNativeState.mode).toBe("SOS");
      expect(mockNativeState.lowLatency).toBe(true);

      await sonarMeshBridge.stopMesh();
      expect(mockNativeState.serviceRunning).toBe(false);
    });

    it("T1-F7-5: isIgnoringBatteryOptimizations exists on bridge and native module and returns boolean", async () => {
      setMockPlatform("android", 34);
      mockNativeState.ignoringBatteryOptimizations = false;
      vi.resetModules();
      const { SonarMeshNative } = await import("sonarmesh-native");
      const { sonarMeshBridge } = await import("@/native/sonarMeshBridge");

      expect(typeof (SonarMeshNative as unknown as Record<string, unknown>)?.isIgnoringBatteryOptimizations).toBe("function");
      const nativeRes = await (SonarMeshNative as unknown as {
        isIgnoringBatteryOptimizations: () => Promise<boolean>;
      }).isIgnoringBatteryOptimizations();
      expect(nativeRes).toBe(false);

      const bridgeFn = (sonarMeshBridge as unknown as {
        isIgnoringBatteryOptimizations?: () => Promise<boolean>;
      }).isIgnoringBatteryOptimizations;
      expect(typeof bridgeFn).toBe("function");
      expect(await bridgeFn!.call(sonarMeshBridge)).toBe(false);

      mockNativeState.ignoringBatteryOptimizations = true;
      expect(await bridgeFn!.call(sonarMeshBridge)).toBe(true);
    });
  });

  describe("F8: BLE Advertising & Filtered Scanning", () => {
    it("T1-F8-1: SONARMESH_CONSTANTS BLE UUID and Manufacturer ID match BleMeshTransport.kt", () => {
      const bleKt = fs.readFileSync(
        path.join(
          ROOT_DIR,
          "modules/sonarmesh-native/android/src/main/java/com/aryakhaslana/sonarmesh/ble/BleMeshTransport.kt"
        ),
        "utf8"
      );
      expect(bleKt).toContain(SONARMESH_CONSTANTS.BLE_SERVICE_UUID);
      expect(bleKt).toContain(`const val MANUFACTURER_ID = 0x${SONARMESH_CONSTANTS.BLE_MANUFACTURER_ID.toString(16)}`);
    });

    it("T1-F8-2: sonarMeshBridge.broadcastBle encodes 56B packet to Base64 and invokes broadcastBlePacket", async () => {
      setMockPlatform("android", 34);
      vi.resetModules();
      const { sonarMeshBridge } = await import("@/native/sonarMeshBridge");
      const raw56 = encodeSmpV1(makeSamplePacket());
      await sonarMeshBridge.broadcastBle(raw56, 4000);

      const call = mockNativeState.calls.find((c) => c.method === "broadcastBlePacket");
      expect(call).toBeDefined();
      expect(call!.args[0]).toBe(bytesToBase64(raw56));
      expect(call!.args[1]).toBe(4000);
    });

    it("T1-F8-3: inbound BLE onPacketReceived passes decodeSmpV1 and propagates to bridge onPacket", async () => {
      setMockPlatform("android", 34);
      vi.resetModules();
      const { sonarMeshBridge } = await import("@/native/sonarMeshBridge");
      const events: Array<{ packetBase64: string; transport: string; rssi: number; relayed: boolean }> = [];
      sonarMeshBridge.attach({
        onPacket: (ev) => events.push(ev),
        onSpectrum: () => {},
        onCalibration: () => {},
        onImpact: () => {},
        onSensors: () => {},
        onError: () => {},
      });

      const raw56 = encodeSmpV1(makeSamplePacket({ shortPayload: "BLE RELAY" }));
      emitNativeEvent("onPacketReceived", {
        packetBase64: bytesToBase64(raw56),
        transport: "ble",
        rssi: -67,
        relayed: true,
        snrDb: 0,
      });

      expect(events).toHaveLength(1);
      expect(events[0].transport).toBe("ble");
      expect(events[0].relayed).toBe(true);
      const dec = decodeSmpV1(base64ToBytes(events[0].packetBase64));
      expect(dec.ok).toBe(true);
      sonarMeshBridge.detach();
    });

    it("T1-F8-4: BleMeshTransport.kt configures hardware ScanFilter and BLE 5 extended + legacy BLE 4.x fragmentation", () => {
      const bleKt = fs.readFileSync(
        path.join(
          ROOT_DIR,
          "modules/sonarmesh-native/android/src/main/java/com/aryakhaslana/sonarmesh/ble/BleMeshTransport.kt"
        ),
        "utf8"
      );
      expect(bleKt).toContain("ScanFilter.Builder().setServiceUuid");
      expect(bleKt).toContain("setManufacturerData");
      expect(bleKt).toContain("isLeExtendedAdvertisingSupported");
      expect(bleKt).toContain("LegacyBleFragmentCodec");
      expect(bleKt).toContain("SmpV1Codec.PACKET_SIZE");
    });

    it("T1-F8-5: withSonarMeshAndroid registers optional hardware uses-feature entries with required='false'", async () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const plugin = require(path.join(ROOT_DIR, "plugins/withSonarMeshAndroid.js"));
      const configured = plugin({ name: "SonarMesh", slug: "solarpush-sonarmesh" });
      const result = await configured.mods.android.manifest({
        modRequest: {},
        modResults: { manifest: { $: {}, application: [{ $: {} }] } },
      });
      const features = result.modResults.manifest["uses-feature"] as Array<{ $: Record<string, string> }>;
      const names = features.map((f) => f.$["android:name"]);
      expect(names).toEqual(
        expect.arrayContaining([
          "android.hardware.bluetooth_le",
          "android.hardware.microphone",
          "android.hardware.sensor.accelerometer",
          "android.hardware.sensor.light",
          "android.hardware.sensor.compass",
        ])
      );
      for (const f of features) {
        expect(f.$["android:required"]).toBe("false");
      }
    });
  });

  describe("F9: Multi-Trigger SOS & Pocket Detection", () => {
    it("T1-F9-1: DEFAULT_SONARMESH_SETTINGS defines impact, pocket lux, countdown, and proximity RSSI defaults", () => {
      expect(DEFAULT_SONARMESH_SETTINGS.impactThresholdMs2).toBe(28.0);
      expect(DEFAULT_SONARMESH_SETTINGS.pocketLuxThreshold).toBe(5.0);
      expect(DEFAULT_SONARMESH_SETTINGS.sosCountdownSec).toBe(10);
      expect(DEFAULT_SONARMESH_SETTINGS.pocketProximityRssiDbm).toBe(-68);
    });

    it("T1-F9-2: sonarMeshBridge.simulatePocketToggle emits isPocketBag and corresponding lightLux", async () => {
      setMockPlatform("web", 0);
      vi.resetModules();
      const { sonarMeshBridge } = await import("@/native/sonarMeshBridge");
      const snaps: Array<{ isPocketBag: boolean; lightLux: number }> = [];
      sonarMeshBridge.attach({
        onPacket: () => {},
        onSpectrum: () => {},
        onCalibration: () => {},
        onImpact: () => {},
        onSensors: (s) => snaps.push(s),
        onError: () => {},
      });

      sonarMeshBridge.simulatePocketToggle(true);
      expect(snaps.at(-1)?.isPocketBag).toBe(true);
      expect(snaps.at(-1)!.lightLux).toBeLessThanOrEqual(5.0);

      sonarMeshBridge.simulatePocketToggle(false);
      expect(snaps.at(-1)?.isPocketBag).toBe(false);
      expect(snaps.at(-1)!.lightLux).toBeGreaterThan(5.0);
      sonarMeshBridge.detach();
    });

    it("T1-F9-3: sonarMeshBridge.simulateImpactShock emits onImpact and elevated accelMagnitudeMs2", async () => {
      setMockPlatform("web", 0);
      vi.resetModules();
      const { sonarMeshBridge } = await import("@/native/sonarMeshBridge");
      let impactMag = 0;
      let sensorMag = 0;
      sonarMeshBridge.attach({
        onPacket: () => {},
        onSpectrum: () => {},
        onCalibration: () => {},
        onImpact: (ev) => {
          impactMag = ev.magnitudeMs2;
        },
        onSensors: (s) => {
          sensorMag = s.accelMagnitudeMs2;
        },
        onError: () => {},
      });

      sonarMeshBridge.simulateImpactShock(35.2);
      expect(impactMag).toBeCloseTo(35.2, 1);
      expect(sensorMag).toBeCloseTo(35.2, 1);
      sonarMeshBridge.detach();
    });

    it("T1-F9-4: useSonarMeshApp.toggleSos activates SOS, dispatches MANUAL packet, and stops on second toggle", async () => {
      setMockPlatform("android", 34);
      grantAllAndroidPermissions();
      vi.resetModules();
      const hook = await mountUseSonarMeshApp();
      try {
        expect(hook.state.sosActive).toBe(false);
        await hook.run(async () => {
          await hook.state.toggleSos();
        });
        expect(hook.state.sosActive).toBe(true);
        expect(mockNativeState.calls.some((c) => c.method === "broadcastBlePacket")).toBe(true);

        await hook.run(async () => {
          await hook.state.toggleSos();
        });
        expect(hook.state.sosActive).toBe(false);
      } finally {
        await hook.unmount();
      }
    });

    it("T1-F9-5: impact event in useSonarMeshApp starts countdownSec and cancelSosCountdown aborts auto-SOS", async () => {
      setMockPlatform("android", 34);
      grantAllAndroidPermissions();
      vi.resetModules();
      const hook = await mountUseSonarMeshApp();
      try {
        await hook.run(async () => {
          emitNativeEvent("onImpactDetected", { magnitudeMs2: 36.0, isPocketBag: false });
        });
        expect(hook.state.countdownSec).toBe(DEFAULT_SONARMESH_SETTINGS.sosCountdownSec);

        await hook.run(async () => {
          hook.state.cancelSosCountdown();
        });
        expect(hook.state.countdownSec).toBeNull();
        expect(hook.state.sosActive).toBe(false);
      } finally {
        await hook.unmount();
      }
    });
  });

  describe("F10: 3.5 kHz Rescue Siren", () => {
    it("T1-F10-1: SONARMESH_CONSTANTS.SIREN_FREQ_HZ equals 3500", () => {
      expect(SONARMESH_CONSTANTS.SIREN_FREQ_HZ).toBe(3500);
    });

    it("T1-F10-2: sonarMeshBridge.startSiren and stopSiren delegate cleanly to SonarMeshNative on Android", async () => {
      setMockPlatform("android", 34);
      vi.resetModules();
      const { sonarMeshBridge } = await import("@/native/sonarMeshBridge");
      await sonarMeshBridge.startSiren();
      expect(mockNativeState.sirenPlaying).toBe(true);
      await sonarMeshBridge.stopSiren();
      expect(mockNativeState.sirenPlaying).toBe(false);
    });

    it("T1-F10-3: inbound packet with sirenReq=true activates siren in useSonarMeshApp", async () => {
      setMockPlatform("android", 34);
      grantAllAndroidPermissions();
      vi.resetModules();
      const hook = await mountUseSonarMeshApp();
      try {
        const raw56 = encodeSmpV1(
          makeSamplePacket({ packetId: "5150515051505150", sirenReq: true })
        );
        await hook.run(async () => {
          emitNativeEvent("onPacketReceived", {
            packetBase64: bytesToBase64(raw56),
            transport: "ble",
            rssi: -75,
            relayed: false,
            snrDb: 0,
          });
        });
        expect(hook.state.sirenActive).toBe(true);
        expect(mockNativeState.sirenPlaying).toBe(true);
      } finally {
        await hook.unmount();
      }
    });

    it("T1-F10-4: pocketed active SOS + responder packet with rssi >= -68 dBm auto-triggers 3.5 kHz siren", async () => {
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
            headingDeg: 10,
          });
        });
        const responderRaw = encodeSmpV1(
          makeSamplePacket({
            packetId: "7777666655554444",
            senderHint: "12123434",
            sirenReq: false,
          })
        );
        await hook.run(async () => {
          emitNativeEvent("onPacketReceived", {
            packetBase64: bytesToBase64(responderRaw),
            transport: "ble",
            rssi: -64,
            relayed: false,
            snrDb: 0,
          });
        });
        expect(hook.state.sirenActive).toBe(true);
      } finally {
        await hook.unmount();
      }
    });

    it("T1-F10-5: useSonarMeshApp.toggleSiren silences active siren and calls stopSiren", async () => {
      setMockPlatform("android", 34);
      grantAllAndroidPermissions();
      vi.resetModules();
      const hook = await mountUseSonarMeshApp();
      try {
        await hook.run(async () => {
          await hook.state.toggleSiren();
        });
        expect(hook.state.sirenActive).toBe(true);

        await hook.run(async () => {
          await hook.state.toggleSiren();
        });
        expect(hook.state.sirenActive).toBe(false);
        expect(mockNativeState.sirenPlaying).toBe(false);
      } finally {
        await hook.unmount();
      }
    });
  });

  describe("F11: Offline Persistence & Geodesy", () => {
    it("T1-F11-1: haversineMeters, bearingDegrees, relativeBearing, and estimateDistanceFromRssi compute accurate offline values", () => {
      const dist = haversineMeters(-7.257472, 112.752088, -7.256472, 112.752088);
      expect(dist).toBeGreaterThan(105);
      expect(dist).toBeLessThan(118);
      expect(bearingDegrees(-7.257472, 112.752088, -7.256472, 112.752088)).toBeCloseTo(0, 1);
      expect(relativeBearing(90, 45)).toBe(45);
      expect(relativeBearing(10, 350)).toBe(20);
      expect(estimateDistanceFromRssi(-59)).toBeCloseTo(1.0, 1);
    });

    it("T1-F11-2: geodesy quantizers and label formatters map telemetry buckets accurately", () => {
      expect(accuracyMetersToBucket(4)).toBe(1);
      expect(gpsAccuracyBucketLabel(1)).toBe("<=5m");
      expect(batteryPctToQuant(100)).toBe(15);
      expect(batteryQuantToPct(15)).toBe(100);
      expect(cardinalDirectionId(0)).toBe("Utara");
      expect(cardinalDirectionId(90)).toBe("Timur");
      expect(formatDistance(8.25)).toBe("8.3 m");
      expect(formatDistance(1500)).toBe("1.50 km");
      expect(formatAgeId(3)).toBe("baru saja");
      expect(formatAgeId(125)).toBe("2 mnt lalu");
    });

    it("T1-F11-3: packetStore.savePacket + loadPackets persists and deduplicates on both Web and Android SQLite", async () => {
      const raw56 = encodeSmpV1(makeSamplePacket({ packetId: "1234123412341234" }));

      // Web localStorage
      setMockPlatform("web", 0);
      vi.resetModules();
      const webStoreMod = await import("@/storage/packetStore");
      const recWeb = webStoreMod.createRecordFromBytes(raw56, {
        transport: "ble",
        rssi: -62,
        snrDb: 0,
        relayed: false,
      })!;
      await webStoreMod.packetStore.savePacket(recWeb);
      await webStoreMod.packetStore.savePacket(recWeb);
      const webPackets = await webStoreMod.packetStore.loadPackets();
      expect(webPackets).toHaveLength(1);
      expect(webPackets[0].packetId).toBe("1234123412341234");

      // Android SQLite
      setMockPlatform("android", 34);
      vi.resetModules();
      const androidStoreMod = await import("@/storage/packetStore");
      const recAnd = androidStoreMod.createRecordFromBytes(raw56, {
        transport: "ultrasonic",
        rssi: -55,
        snrDb: 18,
        relayed: false,
      })!;
      await androidStoreMod.packetStore.savePacket(recAnd);
      await androidStoreMod.packetStore.savePacket(recAnd);
      const androidPackets = await androidStoreMod.packetStore.loadPackets();
      expect(androidPackets).toHaveLength(1);
      expect(androidPackets[0].transport).toBe("ultrasonic");
    });

    it("T1-F11-4: packetStore.setOnboardingCompleted and settings persist across reloads, and clearPackets preserves settings", async () => {
      setMockPlatform("android", 34);
      vi.resetModules();
      const storeMod = await import("@/storage/packetStore");
      const ps = storeMod.packetStore as unknown as {
        init: () => Promise<void>;
        setOnboardingCompleted: (v: boolean) => Promise<void>;
        loadDeviceState: () => Promise<Record<string, any>>;
        saveDeviceState: (s: Record<string, any>) => Promise<void>;
        savePacket: (r: unknown) => Promise<void>;
        loadPackets: () => Promise<unknown[]>;
        clearPackets: () => Promise<void>;
      };

      expect(typeof ps.setOnboardingCompleted).toBe("function");

      await ps.init();
      await ps.setOnboardingCompleted(true);
      const current = await ps.loadDeviceState();
      await ps.saveDeviceState({
        ...current,
        settings: { ...current.settings, defaultTtl: 8, impactThresholdMs2: 32 },
      });
      const rec = storeMod.createRecordFromBytes(encodeSmpV1(makeSamplePacket()), {
        transport: "ble",
        rssi: -60,
        snrDb: 0,
        relayed: false,
      });
      await ps.savePacket(rec);
      await ps.clearPackets();

      expect(await ps.loadPackets()).toHaveLength(0);
      const reloaded = (await ps.loadDeviceState()) as Record<string, any>;
      expect(reloaded.onboardingCompleted).toBe(true);
      expect(reloaded.settings.defaultTtl).toBe(8);
      expect(reloaded.settings.impactThresholdMs2).toBe(32);
      const lat = reloaded.lastLatitude ?? reloaded.lastLat;
      const lon = reloaded.lastLongitude ?? reloaded.lastLon;
      expect(typeof lat).toBe("number");
      expect(typeof lon).toBe("number");
    });

    it("T1-F11-5: locationService returns granted expo-location fix when permission is granted", async () => {
      mockLocationState.permissionStatus = "granted";
      mockLocationState.coords = { latitude: -6.175392, longitude: 106.827153, accuracy: 6.0 };
      vi.resetModules();
      const locMod = (await import("@/services/locationService")) as Record<string, any>;
      const fn = locMod.getCurrentLocation ?? locMod.getOfflineSafeLocation ?? locMod.fetchDeviceLocation;
      expect(typeof fn).toBe("function");
      const res = await fn();
      expect(res.lat ?? res.latitude).toBeCloseTo(-6.175392, 5);
      expect(res.lon ?? res.longitude).toBeCloseTo(106.827153, 5);
      expect(res.isFallback).toBe(false);
    });
  });

  describe("F13: Startup Safety & Permission Guarding", () => {
    it("T1-F13-1: useSonarMeshApp initializes safely with bootStatus='ready' and never starts FGS/mic on un-onboarded mount", async () => {
      setMockPlatform("android", 34);
      // Permissions denied and onboardingCompleted=false
      vi.resetModules();
      const hook = await mountUseSonarMeshApp();
      try {
        expect(hook.state.bootStatus).toBe("ready");
        expect(hook.state.onboardingCompleted).toBe(false);
        expect(mockNativeState.calls.some((c) => c.method === "startMeshService")).toBe(false);
        expect(mockNativeState.calls.some((c) => c.method === "startAcousticListen")).toBe(false);
      } finally {
        await hook.unmount();
      }
    });

    it("T1-F13-2: androidPermissions.getPermissionSnapshot returns all 5 keys across API 24-30 and API 31-35", async () => {
      vi.resetModules();
      const perms = await import("@/permissions/androidPermissions");

      // API 28
      setMockPlatform("android", 28);
      setMockPermission("android.permission.ACCESS_FINE_LOCATION", "granted");
      setMockPermission("android.permission.RECORD_AUDIO", "granted");
      const snap28 = await perms.getPermissionSnapshot();
      expect(Object.keys(snap28).sort()).toEqual([
        "batteryOptimization",
        "bluetooth",
        "location",
        "microphone",
        "notifications",
      ]);
      expect(snap28.location).toBe("granted");
      expect(snap28.microphone).toBe("granted");

      // API 34
      setMockPlatform("android", 34);
      setMockPermission("android.permission.BLUETOOTH_SCAN", "granted");
      setMockPermission("android.permission.BLUETOOTH_ADVERTISE", "granted");
      setMockPermission("android.permission.BLUETOOTH_CONNECT", "granted");
      setMockPermission("android.permission.POST_NOTIFICATIONS", "granted");
      const snap34 = await perms.getPermissionSnapshot();
      expect(snap34.bluetooth).toBe("granted");
      expect(snap34.notifications).toBe("granted");
    });

    it("T1-F13-3: hasMeshBluetoothPermission and hasMicrophonePermission return true when required grants exist", async () => {
      vi.resetModules();
      const perms = await import("@/permissions/androidPermissions");
      setMockPlatform("android", 34);
      expect(
        perms.hasMeshBluetoothPermission({
          bluetooth: "granted",
          location: "denied",
          microphone: "denied",
          notifications: "denied",
          batteryOptimization: "denied",
        })
      ).toBe(true);
      expect(
        perms.hasMicrophonePermission({
          bluetooth: "denied",
          location: "denied",
          microphone: "granted",
          notifications: "denied",
          batteryOptimization: "denied",
        })
      ).toBe(true);
    });

    it("T1-F13-4: requestPermission requests Android permission and openAppSettings invokes Linking.openSettings", async () => {
      vi.resetModules();
      const perms = await import("@/permissions/androidPermissions");
      setMockPlatform("android", 34);
      setMockPermission("android.permission.RECORD_AUDIO", "granted");

      const status = await perms.requestPermission("microphone");
      expect(status).toBe("granted");

      await perms.openAppSettings();
      expect(mockOsState.linkingOpenSettingsCalls).toBe(1);
    });

    it("T1-F13-5: Kotlin native classes wrap FGS, AudioManager, BLE, and Activity calls in crash-safe try/catch blocks", () => {
      const nativeDir = path.join(
        ROOT_DIR,
        "modules/sonarmesh-native/android/src/main/java/com/aryakhaslana/sonarmesh"
      );
      const moduleKt = fs.readFileSync(path.join(nativeDir, "SonarMeshNativeModule.kt"), "utf8");
      const fgsKt = fs.readFileSync(path.join(nativeDir, "ble/SonarMeshForegroundService.kt"), "utf8");
      const modemKt = fs.readFileSync(path.join(nativeDir, "audio/UltrasonicModem.kt"), "utf8");
      const bleKt = fs.readFileSync(path.join(nativeDir, "ble/BleMeshTransport.kt"), "utf8");

      expect(moduleKt).toContain("emitNativeError");
      expect(moduleKt).toContain("catch (t: Throwable)");
      expect(moduleKt).toContain("hasBlePermissions");
      expect(fgsKt).toContain("try {");
      expect(bleKt).toContain("SecurityException");
      expect(modemKt).toMatch(/setStreamVolume[\s\S]*?catch|try\s*\{[\s\S]*?setStreamVolume/);
    });
  });
});
