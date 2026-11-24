import { describe, expect, it, vi } from "vitest";
import { COLORS } from "@/theme/tokens";

vi.mock("react-native", () => ({
  Platform: {
    OS: "android",
    Version: 35,
    select: (obj: Record<string, unknown>) => obj.android ?? obj.default,
  },
  PermissionsAndroid: {
    PERMISSIONS: {
      ACCESS_FINE_LOCATION: "android.permission.ACCESS_FINE_LOCATION",
      RECORD_AUDIO: "android.permission.RECORD_AUDIO",
    },
    RESULTS: {
      GRANTED: "granted",
      DENIED: "denied",
    },
    check: vi.fn(async () => false),
    requestMultiple: vi.fn(async () => ({})),
  },
}));

vi.mock("@/native/sonarMeshBridge", () => ({
  sonarMeshBridge: {
    isIgnoringBatteryOptimizations: vi.fn(async () => false),
    requestIgnoreBatteryOptimizations: vi.fn(async () => false),
  },
}));

describe("Android runtime permissions & light theme safety", () => {
  it("blocks starting connectedDevice foreground service when Bluetooth or Location is ungranted", async () => {
    const perms = await import("./androidPermissions");
    const denied = await perms.checkAllPermissions();
    expect(denied.bluetooth).toBe(false);
    expect(denied.location).toBe(false);
    expect(perms.canStartMeshSafely(denied)).toBe(false);
    expect(perms.listMissingCorePermissions(denied)).toEqual([
      "Bluetooth",
      "Lokasi",
      "Mikrofon",
      "Notifikasi",
    ]);

    expect(
      perms.canStartMeshSafely({
        bluetooth: true,
        location: true,
        microphone: false,
        notifications: false,
        battery: false,
      })
    ).toBe(true);
  });

  it("handles permission API rejections without throwing during startup", async () => {
    const { PermissionsAndroid } = await import("react-native");
    vi.mocked(PermissionsAndroid.check).mockRejectedValueOnce(new Error("Binder dead"));
    const perms = await import("./androidPermissions");
    const snap = await perms.checkAllPermissions();
    expect(snap.bluetooth).toBe(false);
  });

  it("enforces minimalist light theme surface and high-contrast tokens", () => {
    expect(COLORS.ground).toBe("#F7F9FC");
    expect(COLORS.surface).toBe("#FFFFFF");
    expect(COLORS.text).toBe("#0F172A");
  });
});
