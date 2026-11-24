import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SONARMESH_SETTINGS } from "@/config/sonarmeshConfig";
import { encodeSmpV1, type SmpV1Packet } from "@/protocol/smpv1";

const mockPlatform = { OS: "android" as "android" | "web" };
const mockOpenDatabaseAsync = vi.fn();

vi.mock("react-native", () => ({
  Platform: mockPlatform,
}));

vi.mock("expo-sqlite", () => ({
  openDatabaseAsync: mockOpenDatabaseAsync,
}));

function makePacket(overrides: Partial<SmpV1Packet> = {}): SmpV1Packet {
  return {
    triggerType: "MANUAL",
    envPocketBag: false,
    sirenReq: false,
    ttl: 4,
    packetId: "1122334455667788",
    seqCounter: 1,
    latitude: -7.257472,
    longitude: 112.752088,
    gpsAccBucket: 2,
    batteryQuant: 13,
    ageSec: 5,
    senderHint: "cafebabe",
    powNonce: 12,
    shortPayload: "HELP",
    ...overrides,
  };
}

describe("OfflinePacketStore persistence & fallback safety", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockPlatform.OS = "android";
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("falls back to in-memory persistence without throwing when expo-sqlite fails on native", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockOpenDatabaseAsync.mockRejectedValue(new Error("SQLite open failed"));

    const { OfflinePacketStore, createRecordFromBytes } = await import("./packetStore");
    const store = new OfflinePacketStore();

    await expect(store.init()).resolves.toBeUndefined();
    expect(store.isUsingMemoryFallback()).toBe(true);
    expect(warnSpy).toHaveBeenCalled();

    const state = await store.loadDeviceState();
    expect(state.onboardingCompleted).toBe(false);

    await store.setOnboardingCompleted(true);
    const updated = await store.loadDeviceState();
    expect(updated.onboardingCompleted).toBe(true);

    const rec = createRecordFromBytes(encodeSmpV1(makePacket()), {
      transport: "ble",
      rssi: -64,
      snrDb: 0,
      relayed: true,
    });
    expect(rec).not.toBeNull();
    await store.savePacket(rec!);
    await store.savePacket(rec!); // deduplicate by packetId

    const loaded = await store.loadPackets(10);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].packetId).toBe("1122334455667788");

    await store.clearPackets();
    expect(await store.loadPackets(10)).toEqual([]);
  });

  it("deduplicates concurrent init() calls via Promise.all", async () => {
    let resolveDb!: (val: unknown) => void;
    const pendingDb = new Promise((resolve) => {
      resolveDb = resolve;
    });
    const fakeDb = {
      execAsync: vi.fn().mockResolvedValue(undefined),
      runAsync: vi.fn().mockResolvedValue(undefined),
      getAllAsync: vi.fn().mockResolvedValue([]),
      getFirstAsync: vi.fn().mockResolvedValue(null),
    };
    mockOpenDatabaseAsync.mockReturnValue(pendingDb);

    const { OfflinePacketStore } = await import("./packetStore");
    const store = new OfflinePacketStore();

    const p = Promise.all([store.loadDeviceState(), store.loadPackets(100)]);
    resolveDb(fakeDb);
    await p;

    expect(mockOpenDatabaseAsync).toHaveBeenCalledTimes(1);
    expect(fakeDb.execAsync).toHaveBeenCalledTimes(1);
    expect(store.isUsingMemoryFallback()).toBe(false);
  });

  it("migrates legacy device_state JSON missing onboardingCompleted and recovers from corrupt JSON", async () => {
    const kvData = new Map<string, string>();
    kvData.set(
      "device_state",
      JSON.stringify({
        senderHint: "abcd1234",
        seqCounter: 9,
        settings: { defaultTtl: 7 },
      })
    );
    const fakeDb = {
      execAsync: vi.fn().mockResolvedValue(undefined),
      runAsync: vi.fn(async (_sql: string, serialized: string) => {
        kvData.set("device_state", serialized);
      }),
      getAllAsync: vi.fn().mockResolvedValue([]),
      getFirstAsync: vi.fn(async () => {
        const val = kvData.get("device_state");
        return val ? { value: val } : null;
      }),
    };
    mockOpenDatabaseAsync.mockResolvedValue(fakeDb);

    const { OfflinePacketStore } = await import("./packetStore");
    const store = new OfflinePacketStore();

    const migrated = await store.loadDeviceState();
    expect(migrated.senderHint).toBe("abcd1234");
    expect(migrated.seqCounter).toBe(9);
    expect(migrated.onboardingCompleted).toBe(false);
    expect(migrated.settings.defaultTtl).toBe(7);
    expect(migrated.settings.freqSpace0Hz).toBe(DEFAULT_SONARMESH_SETTINGS.freqSpace0Hz);

    await store.setOnboardingCompleted(true);
    expect((await store.loadDeviceState()).onboardingCompleted).toBe(true);
    await store.setOnboardingCompleted(false);
    expect((await store.loadDeviceState()).onboardingCompleted).toBe(false);

    // Corrupt non-object JSON recovers cleanly
    kvData.set("device_state", "null");
    const recovered = await store.loadDeviceState();
    expect(recovered.onboardingCompleted).toBe(false);
    expect(recovered.senderHint).toHaveLength(8);
  });
});
