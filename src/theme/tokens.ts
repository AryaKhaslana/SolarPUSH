import { Platform } from "react-native";

/**
 * Modern minimalist light design system for SonarMesh.
 * Palette is restrained: soft slate canvas, pure white elevated cards,
 * deep refined petrol-teal for radar/utility, and clear semantic red strictly for SOS.
 * Every foreground/background pair meets WCAG AA (>= 4.5:1).
 */
export const COLORS = {
  ground: "#F7F9FC",
  surface: "#FFFFFF",
  surfaceSubtle: "#F1F5F9",
  surfaceElevated: "#EDF2F7",
  border: "#E2E8F0",
  borderStrong: "#CBD5E1",
  rule: "#EEF2F6",

  text: "#0F172A",          // 17.8:1 on #FFFFFF
  textSecondary: "#334155", // 10.3:1 on #FFFFFF
  muted: "#475569",         // 7.5:1 on #FFFFFF

  // Primary calm utility accent (Radar, active navigation, ultrasonic FSK)
  sonar: "#0D7C86",         // 5.0:1 on #FFFFFF; #FFFFFF on #0D7C86 = 5.0:1
  sonarDark: "#0A6068",     // 7.2:1 on #E6F5F6
  sonarSoft: "#E6F5F6",
  sonarBorder: "#B5E1E5",

  // Emergency SOS semantic tones (reserved strictly for SOS & critical alerts)
  sos: "#B91C1C",           // 6.4:1 on #FEF2F2
  sosFill: "#C81E1E",       // 5.9:1 with #FFFFFF
  sosRing: "#FEE2E2",
  sosSoft: "#FEF2F2",
  sosBorder: "#FECACA",

  // Warning / Pocket / Siren semantic tones
  amber: "#9A3412",         // 7.0:1 on #FFF7ED
  amberFill: "#C2410C",     // 5.1:1 with #FFFFFF
  amberSoft: "#FFF7ED",
  amberBorder: "#FED7AA",

  // Positive / Verified / Offline Ready semantic tones
  positive: "#166534",      // 7.1:1 on #F0FDF4
  positiveDot: "#16A34A",
  positiveSoft: "#F0FDF4",
  positiveBorder: "#BBF7D0",

  white: "#FFFFFF",
} as const;

export const FONTS = {
  sans: Platform.select({
    android: "sans-serif",
    ios: "System",
    default: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  }),
  sansMedium: Platform.select({
    android: "sans-serif-medium",
    ios: "System",
    default: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  }),
  mono: Platform.select({
    android: "monospace",
    ios: "Menlo",
    default: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
  }),
} as const;

export const CARD_SHADOW = Platform.select({
  ios: {
    shadowColor: "#0F172A",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
  },
  android: {
    elevation: 1,
  },
  default: {
    shadowColor: "#0F172A",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.04,
    shadowRadius: 8,
  },
});
