import { Platform } from "react-native";

export interface OfflineSafeLocation {
  lat: number;
  lon: number;
  latitude: number;
  longitude: number;
  accuracyM: number;
  isFallback: boolean;
}

const DEFAULT_FALLBACK = {
  lat: -7.257472,
  lon: 112.752088,
  accuracyM: 25,
};

function makeFallback(
  fallback?: { lat?: number; lon?: number; accuracyM?: number }
): OfflineSafeLocation {
  const lat =
    typeof fallback?.lat === "number" && Number.isFinite(fallback.lat)
      ? fallback.lat
      : DEFAULT_FALLBACK.lat;
  const lon =
    typeof fallback?.lon === "number" && Number.isFinite(fallback.lon)
      ? fallback.lon
      : DEFAULT_FALLBACK.lon;
  const accuracyM =
    typeof fallback?.accuracyM === "number" && Number.isFinite(fallback.accuracyM)
      ? fallback.accuracyM
      : DEFAULT_FALLBACK.accuracyM;

  return {
    lat,
    lon,
    latitude: lat,
    longitude: lon,
    accuracyM,
    isFallback: true,
  };
}

/**
 * Fetches device GPS coordinates safely for offline/Airplane Mode use.
 * Never throws: falls back to last-known fix or persisted/default coordinates
 * whenever permission is denied or OS location services are unavailable.
 */
export async function getCurrentLocation(
  fallback?: { lat?: number; lon?: number; accuracyM?: number }
): Promise<OfflineSafeLocation> {
  if (Platform.OS === "web") {
    return makeFallback(fallback);
  }

  try {
    const Location = await import("expo-location");
    const perm = await Location.getForegroundPermissionsAsync();
    if (!perm || perm.status !== "granted") {
      return makeFallback(fallback);
    }

    const last = await Location.getLastKnownPositionAsync().catch(() => null);
    if (
      last?.coords &&
      Number.isFinite(last.coords.latitude) &&
      Number.isFinite(last.coords.longitude)
    ) {
      return {
        lat: last.coords.latitude,
        lon: last.coords.longitude,
        latitude: last.coords.latitude,
        longitude: last.coords.longitude,
        accuracyM: last.coords.accuracy ?? fallback?.accuracyM ?? 15,
        isFallback: false,
      };
    }

    const current = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.Balanced,
    });
    if (
      current?.coords &&
      Number.isFinite(current.coords.latitude) &&
      Number.isFinite(current.coords.longitude)
    ) {
      return {
        lat: current.coords.latitude,
        lon: current.coords.longitude,
        latitude: current.coords.latitude,
        longitude: current.coords.longitude,
        accuracyM: current.coords.accuracy ?? fallback?.accuracyM ?? 15,
        isFallback: false,
      };
    }
  } catch {
    // Offline or location disabled: return safe fallback without throwing.
  }

  return makeFallback(fallback);
}

export const getOfflineSafeLocation = getCurrentLocation;
