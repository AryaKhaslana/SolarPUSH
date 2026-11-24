import React from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { COLORS } from "@/theme/tokens";
import { AppErrorBoundary } from "@/components/ErrorBoundary";
import {
  grantAllAndroidPermissions,
  mockNativeState,
  setMockPlatform,
} from "./helpers/nativeMocks";

function hexToLuminance(hex: string): number {
  const cleaned = hex.replace("#", "");
  const r = parseInt(cleaned.slice(0, 2), 16) / 255;
  const g = parseInt(cleaned.slice(2, 4), 16) / 255;
  const b = parseInt(cleaned.slice(4, 6), 16) / 255;
  const toLinear = (c: number) =>
    c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

function contrastRatio(fg: string, bg: string): number {
  const l1 = hexToLuminance(fg);
  const l2 = hexToLuminance(bg);
  const bright = Math.max(l1, l2);
  const dark = Math.min(l1, l2);
  return (bright + 0.05) / (dark + 0.05);
}

interface MiniDomEl {
  tagName?: string;
  textContent?: string;
  childNodes?: MiniDomEl[];
  dispatchEvent?: (ev: { type: string }) => boolean;
  [key: string]: unknown;
}

function clickElement(el: MiniDomEl | undefined): void {
  if (!el) throw new Error("Target button not found");
  const propsKey = Object.keys(el).find((k) => k.startsWith("__reactProps$"));
  const reactProps = propsKey ? (el[propsKey] as { onClick?: (ev: unknown) => void }) : undefined;
  if (typeof reactProps?.onClick === "function") {
    reactProps.onClick({ type: "click", preventDefault() {}, stopPropagation() {} });
    return;
  }
  el.dispatchEvent?.({ type: "click" });
}

function findButtonsByText(root: MiniDomEl, needle: string): MiniDomEl[] {
  const found: MiniDomEl[] = [];
  function walk(node: MiniDomEl | undefined) {
    if (!node) return;
    if (node.tagName === "BUTTON" && (node.textContent ?? "").includes(needle)) {
      found.push(node);
    }
    for (const child of node.childNodes ?? []) {
      walk(child);
    }
  }
  walk(root);
  return found;
}

async function waitForText(
  container: MiniDomEl,
  needle: string,
  timeoutMs = 1500
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((container.textContent ?? "").includes(needle)) return;
    await React.act(async () => {
      await new Promise((r) => setTimeout(r, 15));
    });
  }
  throw new Error(`Expected text "${needle}" not found in "${container.textContent ?? ""}"`);
}

describe("Tier 3 UI, Onboarding, ErrorBoundary & Light Theme Contrast", () => {
  it("T3-UI-1: first launch shows 3-step onboarding, skips cleanly, persists completion, and never starts FGS without permissions", async () => {
    setMockPlatform("android", 34);
    vi.resetModules();
    const { default: App } = await import("../../App");
    const { packetStore } = await import("@/storage/packetStore");

    const container = document.createElement("div") as unknown as MiniDomEl;
    const root = createRoot(container as unknown as Element);

    try {
      await React.act(async () => {
        root.render(React.createElement(App));
      });

      // Step 1 of OnboardingFlow
      await waitForText(container, "Langkah 1 dari 3");
      expect(container.textContent).toContain("Tetap terhubung saat sinyal hilang total");
      expect(mockNativeState.calls.some((c) => c.method === "startMeshService")).toBe(false);

      // Step 1 -> Step 2
      const nextBtn1 = findButtonsByText(container, "Lanjut")[0];
      expect(nextBtn1).toBeDefined();
      await React.act(async () => {
        clickElement(nextBtn1);
      });
      await waitForText(container, "Langkah 2 dari 3");

      // Step 2 -> Step 3 (Permissions)
      const nextBtn2 = findButtonsByText(container, "Lanjut")[0];
      expect(nextBtn2).toBeDefined();
      await React.act(async () => {
        clickElement(nextBtn2);
      });
      await waitForText(container, "Langkah 3 dari 3");
      expect(container.textContent).toContain("Bluetooth (BLE Mesh)");
      expect(container.textContent).toContain("Lokasi GPS Offline");
      expect(container.textContent).toContain("Mikrofon (Sinyal 19 kHz)");
      expect(container.textContent).toContain("Notifikasi Status");
      expect(container.textContent).toContain("Bebas Optimasi Baterai");

      // Skip permission step -> enters main app without crashing or starting FGS
      const skipBtn = findButtonsByText(container, "Lewati, Atur Nanti")[0];
      expect(skipBtn).toBeDefined();
      await React.act(async () => {
        clickElement(skipBtn);
      });

      await waitForText(container, "Bantuan Darurat Tanpa Internet");
      expect(container.textContent).toContain("Beberapa izin belum aktif");
      expect(mockNativeState.calls.some((c) => c.method === "startMeshService")).toBe(false);

      const persisted = await packetStore.loadDeviceState();
      expect(persisted.onboardingCompleted).toBe(true);
    } finally {
      await React.act(async () => {
        root.unmount();
      });
    }
  });

  it("T3-UI-2: returning launch skips onboarding and navigates Radar, Panduan, and Pengaturan cleanly", async () => {
    setMockPlatform("android", 34);
    grantAllAndroidPermissions();
    vi.resetModules();
    const { packetStore } = await import("@/storage/packetStore");
    await packetStore.setOnboardingCompleted(true);

    const { default: App } = await import("../../App");
    const container = document.createElement("div") as unknown as MiniDomEl;
    const root = createRoot(container as unknown as Element);

    try {
      await React.act(async () => {
        root.render(React.createElement(App));
      });

      await waitForText(container, "Bantuan Darurat Tanpa Internet");
      expect(container.textContent).not.toContain("Langkah 1 dari 3");
      expect(container.textContent).toContain("Offline Siap");

      // Switch to Radar tab (empty state + offline coords)
      const radarTab = findButtonsByText(container, "Radar").at(-1);
      expect(radarTab).toBeDefined();
      await React.act(async () => {
        clickElement(radarTab);
      });
      await waitForText(container, "Belum ada sinyal masuk");

      const coordsTab = findButtonsByText(container, "Koordinat Offline")[0];
      expect(coordsTab).toBeDefined();
      await React.act(async () => {
        clickElement(coordsTab);
      });
      await waitForText(container, "Koordinat Offline");

      // Switch to Panduan tab
      const guideTab = findButtonsByText(container, "Panduan").at(-1);
      expect(guideTab).toBeDefined();
      await React.act(async () => {
        clickElement(guideTab);
      });
      await waitForText(container, "Panduan Penggunaan");

      // Switch to Pengaturan tab
      const settingsTab = findButtonsByText(container, "Pengaturan").at(-1);
      expect(settingsTab).toBeDefined();
      await React.act(async () => {
        clickElement(settingsTab);
      });
      await waitForText(container, "Izin Perangkat");
    } finally {
      await React.act(async () => {
        root.unmount();
      });
    }
  });

  it("T3-UI-3: AppErrorBoundary catches render crash and displays recovery fallback instead of crashing", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    function BrokenChild(): React.ReactElement {
      throw new Error("Simulated startup render failure");
    }

    const container = document.createElement("div") as unknown as MiniDomEl;
    const root = createRoot(container as unknown as Element);
    try {
      await React.act(async () => {
        root.render(
          React.createElement(AppErrorBoundary, null, React.createElement(BrokenChild))
        );
      });
      expect(container.textContent).toContain("SonarMesh mengalami kendala tampilan");
      expect(container.textContent).toContain("Simulated startup render failure");
      expect(findButtonsByText(container, "Muat Ulang Aplikasi").length).toBeGreaterThan(0);
    } finally {
      spy.mockRestore();
      warnSpy.mockRestore();
      await React.act(async () => {
        root.unmount();
      });
    }
  });

  it("T3-UI-4: light minimalist theme tokens meet WCAG AA contrast (>= 4.5:1) across all foreground/background pairs", () => {
    const pairs: Array<[string, string, string]> = [
      ["text on surface", COLORS.text, COLORS.surface],
      ["text on ground", COLORS.text, COLORS.ground],
      ["textSecondary on surface", COLORS.textSecondary, COLORS.surface],
      ["muted on surface", COLORS.muted, COLORS.surface],
      ["muted on ground", COLORS.muted, COLORS.ground],
      ["sonar on surface", COLORS.sonar, COLORS.surface],
      ["white on sonar", COLORS.white, COLORS.sonar],
      ["sonarDark on sonarSoft", COLORS.sonarDark, COLORS.sonarSoft],
      ["sos on sosSoft", COLORS.sos, COLORS.sosSoft],
      ["white on sosFill", COLORS.white, COLORS.sosFill],
      ["amber on amberSoft", COLORS.amber, COLORS.amberSoft],
      ["white on amberFill", COLORS.white, COLORS.amberFill],
      ["positive on positiveSoft", COLORS.positive, COLORS.positiveSoft],
    ];

    for (const [label, fg, bg] of pairs) {
      const ratio = contrastRatio(fg, bg);
      expect(ratio, `${label} (${fg} on ${bg}) ratio=${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
    }
  });
});
