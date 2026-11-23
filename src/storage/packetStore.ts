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

/**
 * Local offline storage backed by expo-sqlite on Android and localStorage on Web.
 * Persists decoded SMPv1 packets, deduplication history, last-known GPS fix, and thresholds.
 */
class OfflinePacketStore {
  private sqliteDb: SqliteDbLike | null = null;
  private initialized = false;

  async init(): Promise<void> {
    if (this.initialized) return;
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
      } catch {
        this.sqliteDb = null;
      }
    }
    this.initialized = true;
  }

  async loadDeviceState(): Promise<PersistedDeviceState> {
    await this.init();
    const fallback: PersistedDeviceState = {
      senderHint: randomHex(4),
      seqCounter: 0,
      lastLatitude: -7.257472,
      lastLongitude: 112.752088,
      lastAccuracyM: 12,
      settings: { ...DEFAULT_SONARMESH_SETTINGS },
    };

    try {
      if (this.sqliteDb) {
        const row = await this.sqliteDb.getFirstAsync<{ value: string }>(
          "SELECT value FROM kv_state WHERE key = 'device_state'"
        );
        if (row?.value) {
          const parsed = JSON.parse(row.value) as Partial<PersistedDeviceState>;
          return {
            ...fallback,
            ...parsed,
            settings: { ...DEFAULT_SONARMESH_SETTINGS, ...(parsed.settings ?? {}) },
          };
        }
      } else if (typeof window !== "undefined" && window.localStorage) {
        const raw = window.localStorage.getItem(WEB_STATE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw) as Partial<PersistedDeviceState>;
          return {
            ...fallback,
            ...parsed,
            settings: { ...DEFAULT_SONARMESH_SETTINGS, ...(parsed.settings ?? {}) },
          };
        }
      }
    } catch {
      // Ignore corrupt storage and use fresh state.
    }

    await this.saveDeviceState(fallback);
    return fallback;
  }

  async saveDeviceState(state: PersistedDeviceState): Promise<void> {
    await this.init();
    const serialized = JSON.stringify(state);
    try {
      if (this.sqliteDb) {
        await this.sqliteDb.runAsync(
          "INSERT OR REPLACE INTO kv_state (key, value) VALUES ('device_state', ?)",
          serialized
        );
      } else if (typeof window !== "undefined" && window.localStorage) {
        window.localStorage.setItem(WEB_STATE_KEY, serialized);
      }
    } catch {
      // Ignore storage failures.
    }
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
        }
        return records;
      }

      if (typeof window !== "undefined" && window.localStorage) {
        const raw = window.localStorage.getItem(WEB_PACKETS_KEY);
        if (raw) {
          const parsed = JSON.parse(raw) as StoredSosRecord[];
          if (Array.isArray(parsed)) return parsed.slice(0, limit);
        }
      }
    } catch {
      // Ignore read errors.
    }
    return [];
  }

  async savePacket(record: StoredSosRecord): Promise<void> {
    await this.init();
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

      if (typeof window !== "undefined" && window.localStorage) {
        const existing = await this.loadPackets(200);
        if (existing.some((p) => p.packetId === record.packetId)) return;
        const next = [record, ...existing].slice(0, 150);
        window.localStorage.setItem(WEB_PACKETS_KEY, JSON.stringify(next));
      }
    } catch {
      // Ignore write failures.
    }
  }

  async clearPackets(): Promise<void> {
    await this.init();
    try {
      if (this.sqliteDb) {
        await this.sqliteDb.runAsync("DELETE FROM sos_packets");
      } else if (typeof window !== "undefined" && window.localStorage) {
        window.localStorage.removeItem(WEB_PACKETS_KEY);
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
