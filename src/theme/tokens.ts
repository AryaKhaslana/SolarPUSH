/**
 * High-contrast dark OLED emergency instrument palette for SonarMesh.
 * Designed for low battery drain and clear visibility during power outages.
 */
export const COLORS = {
  ground: "#070A0E",
  surface: "#10161F",
  surfaceElevated: "#17202C",
  border: "#223041",
  rule: "#1A2431",
  text: "#F2F6FA",
  muted: "#96A6B8",
  sonar: "#22C3B8",      // Active radar, ultrasonic signal, live telemetry
  sonarSoft: "#0E2E30",
  sos: "#FF7D82",        // Emergency text/indicators on dark surfaces (6.8:1+)
  sosFill: "#C62831",    // Primary emergency SOS trigger button with #FFFFFF (5.6:1)
  sosRing: "#5E161C",    // Outer tactile ring around SOS trigger
  sosSoft: "#311216",
  amber: "#F0A92D",      // Pocket/bag warning, siren alert, calibration
  amberSoft: "#33250D",
  positive: "#34C77B",   // Offline-ready, CRC verified, GPS locked
  positiveSoft: "#103121",
} as const;
