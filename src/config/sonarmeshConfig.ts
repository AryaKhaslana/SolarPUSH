/**
 * Tunable RF, acoustic FSK, sensor, and relay constants for SonarMesh (SolarPUSH).
 * Exposed centrally to make phone-to-phone field calibration straightforward (OQ-1 & OQ-3).
 */
export interface SonarMeshSettings {
  freqSpace0Hz: number;
  freqMark1Hz: number;
  symbolDurationMs: number;
  impactThresholdMs2: number;
  pocketLuxThreshold: number;
  sosCountdownSec: number;
  defaultTtl: number;
  pocketProximityRssiDbm: number;
}

export const DEFAULT_SONARMESH_SETTINGS: SonarMeshSettings = {
  freqSpace0Hz: 18750,
  freqMark1Hz: 19500,
  symbolDurationMs: 20,
  impactThresholdMs2: 28.0, // ~2.85g shock spike
  pocketLuxThreshold: 5.0,  // <= 5 lux indicates pocket or bag
  sosCountdownSec: 10,
  defaultTtl: 5,
  pocketProximityRssiDbm: -68,
};

export const SONARMESH_CONSTANTS = {
  SAMPLE_RATE_HZ: 48000,
  FFT_SIZE: 1024,
  SIREN_FREQ_HZ: 3500,
  CALIBRATION_DURATION_MS: 3000,
  RELAY_JITTER_MIN_MS: 200,
  RELAY_JITTER_MAX_MS: 2000,
  BLE_SERVICE_UUID: "00005150-0000-1000-8000-00805F9B34FB",
  BLE_MANUFACTURER_ID: 0x5150,
  DEDUP_WINDOW_MS: 10 * 60 * 1000,
} as const;
