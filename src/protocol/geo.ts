/**
 * Offline geodesy, bearing, RSSI distance estimation, and field quantization utilities.
 * Zero network calls or external map tiles required.
 */

const EARTH_RADIUS_M = 6371000;

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

function toDeg(rad: number): number {
  return (rad * 180) / Math.PI;
}

/** Great-circle distance in meters between two WGS-84 coordinates. */
export function haversineMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Initial true bearing in degrees (0..360, North=0, East=90) from point 1 to point 2. */
export function bearingDegrees(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const p1 = toRad(lat1);
  const p2 = toRad(lat2);
  const dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(p2);
  const x =
    Math.cos(p1) * Math.sin(p2) -
    Math.sin(p1) * Math.cos(p2) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Relative bearing (-180..180) relative to the device compass heading. */
export function relativeBearing(targetBearingDeg: number, headingDeg: number): number {
  const diff = ((targetBearingDeg - headingDeg + 540) % 360) - 180;
  return diff;
}

/** Estimates distance in meters from BLE RSSI using log-distance path loss (txPower=-59 dBm, n=2.4). */
export function estimateDistanceFromRssi(rssiDbm: number, txPowerDbm = -59, n = 2.4): number {
  if (rssiDbm >= 0) return 0.5;
  const dist = Math.pow(10, (txPowerDbm - rssiDbm) / (10 * n));
  return Math.round(Math.min(120, Math.max(0.4, dist)) * 10) / 10;
}

export function accuracyMetersToBucket(meters: number | null | undefined): number {
  if (meters == null || meters <= 0) return 0;
  if (meters <= 5) return 1;
  if (meters <= 15) return 2;
  if (meters <= 50) return 3;
  if (meters <= 150) return 4;
  return 5;
}

export function gpsAccuracyBucketLabel(bucket: number): string {
  switch (bucket) {
    case 0:
      return "No fix";
    case 1:
      return "<=5m";
    case 2:
      return "<=15m";
    case 3:
      return "<=50m";
    case 4:
      return "<=150m";
    default:
      return ">150m";
  }
}

export function batteryPctToQuant(pct: number): number {
  return Math.min(15, Math.max(0, Math.round((pct / 100) * 15)));
}

export function batteryQuantToPct(quant: number): number {
  return Math.round((Math.min(15, Math.max(0, quant)) / 15) * 100);
}

export function formatDistance(meters: number): string {
  if (meters < 1000) return `${meters < 10 ? meters.toFixed(1) : Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(2)} km`;
}

const COMPASS_LABELS_ID = [
  "Utara",
  "Timur Laut",
  "Timur",
  "Tenggara",
  "Selatan",
  "Barat Daya",
  "Barat",
  "Barat Laut",
] as const;

export function cardinalDirectionId(deg: number): string {
  const norm = ((deg % 360) + 360) % 360;
  const idx = Math.round(norm / 45) % 8;
  return COMPASS_LABELS_ID[idx];
}

export function formatAgeId(ageSec: number): string {
  if (ageSec < 5) return "baru saja";
  if (ageSec < 60) return `${ageSec} dtk lalu`;
  const mins = Math.floor(ageSec / 60);
  if (mins < 60) return `${mins} mnt lalu`;
  const hrs = Math.floor(mins / 60);
  return `${hrs} jam lalu`;
}
