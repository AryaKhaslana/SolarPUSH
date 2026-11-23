/**
 * High-contrast dark tactical OLED palette for SonarMesh.
 * Dark theme is an explicit operational decision for low-power battery preservation
 * and glare-free visibility during power outages and nighttime disaster response.
 */
export const COLORS = {
  ground: "#0B0E11",
  surface: "#12171E",
  surfaceElevated: "#18202A",
  border: "#24303F",
  rule: "#1C2531",
  text: "#EEF3F8",
  muted: "#95A4B5",
  sonar: "#22C3B8",      // Live radar sweep, FSK ultrasonic signal, active monitor
  sonarSoft: "#0F3132",
  sos: "#FF7B80",        // Emergency SOS text/border on dark surfaces (6.5:1+ WCAG AA)
  sosFill: "#C62831",    // High-contrast filled SOS CTA with #FFFFFF text (5.7:1 WCAG AA)
  sosSoft: "#331216",
  amber: "#F0A92D",      // Pocket/bag warning, retrying, calibration
  amberSoft: "#33250E",
  positive: "#34C77B",   // CRC-16 verified, GPS locked, mesh healthy
  positiveSoft: "#103121",
} as const;
