import { Platform } from "react-native";
import {
  DEFAULT_SONARMESH_SETTINGS,
  type SonarMeshSettings,
} from "@/config/sonarmeshConfig";
import {
  bytesToBase64,
  base64ToBytes,
  decodeSmpV1,
  randomHex,
  type SmpV1Packet,
} from "@/protocol/smpv1";

export interface StoredSosRecord {
  packetId: string;
  packet: SmpV1Packet;
  rawBase64: string;
  transport: "ble" | "ultrasonic" | "local";
  rssi: number;
  snrDb: number;
  relayed: boolean;
  receivedAtMs: number;
}

export interface PersistedDeviceState {
  senderHint: string;
  seqCounter: number;
  lastLatitude: number;
  lastLongitude: number;
  lastAccuracyM: number;
  onboardingCompleted: boolean;
  settings: SonarMeshSettings;
}

const WEB_PACKETS_KEY = "sonarmesh_packets_v1";
const WEB_STATE_KEY = "sonarmesh_state_v1";

interface SqliteDbLike {
  execAsync(sql: string): Promise<void>;
  runAsync(sql: string, ...params: unknown[]): Promise<unknown>;
  getAllAsync<T>(sql: string, ...params: unknown[]): Promise<T[]>;
  getFirstAsync<T>(sql: string, ...params: unknown[]): Promise<T | null>;
}

function createDefaultDeviceState(): PersistedDeviceState {
  return {
    senderHint: randomHex(4),
    seqCounter: 0,
    lastLatitude: -7.257472,
    lastLongitude: 112.752088,
    lastAccuracyM: 12,
    onboardingCompleted: false,
    settings: { ...DEFAULT_SONARMESH_SETTINGS },
  };
}

function mergeDeviceState(
  raw: unknown,
  fallback: PersistedDeviceState
): PersistedDeviceState {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return fallback;
  }
  const parsed = raw as Partial<PersistedDeviceState>;
  const rawSettings =
    parsed.settings && typeof parsed.settings === "object" && !Array.isArray(parsed.settings)
      ? parsed.settings
      : {};
  return {
    senderHint:
      typeof parsed.senderHint === "string" && parsed.senderHint.length > 0
        ? parsed.senderHint
        : fallback.senderHint,
    seqCounter:
      typeof parsed.seqCounter === "number" && Number.isFinite(parsed.seqCounter)
        ? parsed.seqCounter
        : fallback.seqCounter,
    lastLatitude:
      typeof parsed.lastLatitude === "number" && Number.isFinite(parsed.lastLatitude)
        ? parsed.lastLatitude
        : fallback.lastLatitude,
    lastLongitude:
      typeof parsed.lastLongitude === "number" && Number.isFinite(parsed.lastLongitude)
        ? parsed.lastLongitude
        : fallback.lastLongitude,
    lastAccuracyM:
      typeof parsed.lastAccuracyM === "number" && Number.isFinite(parsed.lastAccuracyM)
        ? parsed.lastAccuracyM
        : fallback.lastAccuracyM,
    onboardingCompleted:
      typeof parsed.onboardingCompleted === "boolean"
        ? parsed.onboardingCompleted
        : false,
    settings: { ...DEFAULT_SONARMESH_SETTINGS, ...rawSettings },
  };
}

function getSafeLocalStorage(): Storage | null {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      return window.localStorage;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Local offline storage backed by expo-sqlite on Android and localStorage on Web,
 * with automatic in-memory fallback if native SQLite initialization fails.
 * Persists decoded SMPv1 packets, deduplication history, onboarding completion,
 * last-known GPS fix, and thresholds.
 */
export class OfflinePacketStore {
  private sqliteDb: SqliteDbLike | null = null;
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private usingMemoryFallback = false;
  private memoryState: PersistedDeviceState | null = null;
  private memoryPackets: StoredSosRecord[] = [];

  isUsingMemoryFallback(): boolean {
    return this.usingMemoryFallback;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      if (Platform.OS !== "web") {
        try {
          const SQLite = await import("expo-sqlite");
          const db = (await SQLite.openDatabaseAsync("sonarmesh.db")) as unknown as SqliteDbLike;
          await db.execAsync(`
            PRAGMA journal_mode = WAL;
            CREATE TABLE IF NOT EXISTS sos_packets (
              packet_id TEXT PRIMARY KEY,
              sender_hint TEXT NOT NULL,
              seq_counter INTEGER NOT NULL,
              raw_base64 TEXT NOT NULL,
              transport TEXT NOT NULL,
              rssi INTEGER NOT NULL,
              snr_db REAL NOT NULL,
              relayed INTEGER NOT NULL DEFAULT 0,
              received_at_ms INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_sos_received ON sos_packets(received_at_ms DESC);
            CREATE TABLE IF NOT EXISTS kv_state (
              key TEXT PRIMARY KEY,
              value TEXT NOT NULL
            );
          `);
          this.sqliteDb = db;
          this.usingMemoryFallback = false;
        } catch (err) {
          console.warn(
            "[OfflinePacketStore] SQLite unavailable, using in-memory fallback:",
            err instanceof Error ? err.message : String(err)
          );
          this.sqliteDb = null;
          this.usingMemoryFallback = true;
        }
      } else if (!getSafeLocalStorage()) {
        this.usingMemoryFallback = true;
      }
      this.initialized = true;
    })().finally(() => {
      this.initPromise = null;
    });

    return this.initPromise;
  }

  async loadDeviceState(): Promise<PersistedDeviceState> {
    await this.init();
    const fallback = createDefaultDeviceState();

    try {
      if (this.sqliteDb) {
        const row = await this.sqliteDb.getFirstAsync<{ value: string }>(
          "SELECT value FROM kv_state WHERE key = 'device_state'"
        );
        if (row?.value) {
          const merged = mergeDeviceState(JSON.parse(row.value), fallback);
          this.memoryState = merged;
          return merged;
        }
      } else {
        const storage = getSafeLocalStorage();
        if (storage) {
          const raw = storage.getItem(WEB_STATE_KEY);
          if (raw) {
            const merged = mergeDeviceState(JSON.parse(raw), fallback);
            this.memoryState = merged;
            return merged;
          }
        } else if (this.memoryState) {
          return {
            ...this.memoryState,
            settings: { ...this.memoryState.settings },
          };
        }
      }
    } catch {
      if (this.memoryState) {
        return {
          ...this.memoryState,
          settings: { ...this.memoryState.settings },
        };
      }
    }

    await this.saveDeviceState(fallback);
    return fallback;
  }

  async saveDeviceState(state: PersistedDeviceState): Promise<void> {
    await this.init();
    const normalized = mergeDeviceState(state, createDefaultDeviceState());
    this.memoryState = normalized;
    const serialized = JSON.stringify(normalized);
    try {
      if (this.sqliteDb) {
        await this.sqliteDb.runAsync(
          "INSERT OR REPLACE INTO kv_state (key, value) VALUES ('device_state', ?)",
          serialized
        );
      } else {
        const storage = getSafeLocalStorage();
        if (storage) {
          storage.setItem(WEB_STATE_KEY, serialized);
        }
      }
    } catch {
      this.usingMemoryFallback = true;
    }
  }

  async setOnboardingCompleted(completed: boolean): Promise<void> {
    const current = await this.loadDeviceState();
    await this.saveDeviceState({
      ...current,
      onboardingCompleted: completed,
    });
  }

  async updateSettings(partial: Partial<SonarMeshSettings>): Promise<PersistedDeviceState> {
    const current = await this.loadDeviceState();
    const next: PersistedDeviceState = {
      ...current,
      settings: {
        ...current.settings,
        ...partial,
      },
    };
    await this.saveDeviceState(next);
    return next;
  }

  async loadPackets(limit = 100): Promise<StoredSosRecord[]> {
    await this.init();
    try {
      if (this.sqliteDb) {
        const rows = await this.sqliteDb.getAllAsync<{
          packet_id: string;
          raw_base64: string;
          transport: "ble" | "ultrasonic" | "local";
          rssi: number;
          snr_db: number;
          relayed: number;
          received_at_ms: number;
        }>("SELECT * FROM sos_packets ORDER BY received_at_ms DESC LIMIT ?", limit);

        const records: StoredSosRecord[] = [];
        for (const r of rows) {
          try {
            const decoded = decodeSmpV1(base64ToBytes(r.raw_base64));
            if (decoded.ok) {
              records.push({
                packetId: r.packet_id,
                packet: decoded.packet,
                rawBase64: r.raw_base64,
                transport: r.transport,
                rssi: r.rssi,
                snrDb: r.snr_db,
                relayed: r.relayed === 1,
                receivedAtMs: r.received_at_ms,
              });
            }
          } catch {
            // Skip malformed row.
          }
        }
        return records;
      }

      const storage = getSafeLocalStorage();
      if (storage) {
        const raw = storage.getItem(WEB_PACKETS_KEY);
        if (raw) {
          const parsed = JSON.parse(raw) as StoredSosRecord[];
          if (Array.isArray(parsed)) return parsed.slice(0, limit);
        }
      } else {
        return this.memoryPackets.slice(0, limit);
      }
    } catch {
      return this.memoryPackets.slice(0, limit);
    }
    return this.memoryPackets.slice(0, limit);
  }

  async savePacket(record: StoredSosRecord): Promise<void> {
    await this.init();
    if (!this.memoryPackets.some((p) => p.packetId === record.packetId)) {
      this.memoryPackets = [record, ...this.memoryPackets].slice(0, 150);
    }
    try {
      if (this.sqliteDb) {
        await this.sqliteDb.runAsync(
          `INSERT OR IGNORE INTO sos_packets
            (packet_id, sender_hint, seq_counter, raw_base64, transport, rssi, snr_db, relayed, received_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          record.packetId,
          record.packet.senderHint,
          record.packet.seqCounter,
          record.rawBase64,
          record.transport,
          record.rssi,
          record.snrDb,
          record.relayed ? 1 : 0,
          record.receivedAtMs
        );
        return;
      }

      const storage = getSafeLocalStorage();
      if (storage) {
        const existing = await this.loadPackets(200);
        if (existing.some((p) => p.packetId === record.packetId)) return;
        const next = [record, ...existing].slice(0, 150);
        storage.setItem(WEB_PACKETS_KEY, JSON.stringify(next));
      }
    } catch {
      this.usingMemoryFallback = true;
    }
  }

  async clearPackets(): Promise<void> {
    await this.init();
    this.memoryPackets = [];
    try {
      if (this.sqliteDb) {
        await this.sqliteDb.runAsync("DELETE FROM sos_packets");
      } else {
        const storage = getSafeLocalStorage();
        if (storage) {
          storage.removeItem(WEB_PACKETS_KEY);
        }
      }
    } catch {
      // Ignore delete failures.
    }
  }
}

export const packetStore = new OfflinePacketStore();

export function createRecordFromBytes(
  raw56: Uint8Array,
  meta: {
    transport: "ble" | "ultrasonic" | "local";
    rssi: number;
    snrDb: number;
    relayed: boolean;
  }
): StoredSosRecord | null {
  const decoded = decodeSmpV1(raw56);
  if (!decoded.ok) return null;
  return {
    packetId: decoded.packet.packetId,
    packet: decoded.packet,
    rawBase64: bytesToBase64(raw56),
    transport: meta.transport,
    rssi: meta.rssi,
    snrDb: meta.snrDb,
    relayed: meta.relayed,
    receivedAtMs: Date.now(),
  };
}
