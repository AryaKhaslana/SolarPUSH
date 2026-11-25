import { describe, expect, it, vi } from "vitest";
import { OfflinePacketStore } from "@/storage/packetStore";

vi.mock("react-native", () => ({
  Platform: {
    OS: "web",
    select: (obj: Record<string, unknown>) => obj.default,
  },
}));

vi.mock("expo-sqlite", () => ({
  openDatabaseAsync: vi.fn(),
}));

describe("Onboarding completion & startup persistence", () => {
  it("defaults onboardingCompleted to false on first launch and persists true after completion", async () => {
    const store = new OfflinePacketStore();
    const initial = await store.loadDeviceState();
    expect(initial.onboardingCompleted).toBe(false);

    await store.setOnboardingCompleted(true);
    const returning = await store.loadDeviceState();
    expect(returning.onboardingCompleted).toBe(true);
  });

  it("preserves persisted settings and senderHint across onboarding completion", async () => {
    const store = new OfflinePacketStore();
    const initial = await store.loadDeviceState();
    const customSettings = { ...initial.settings, symbolDurationMs: 25 };
    await store.saveDeviceState({ ...initial, settings: customSettings });
    await store.setOnboardingCompleted(true);

    const next = await store.loadDeviceState();
    expect(next.onboardingCompleted).toBe(true);
    expect(next.senderHint).toBe(initial.senderHint);
    expect(next.settings.symbolDurationMs).toBe(25);
  });
});
