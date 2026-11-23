/**
 * Exact 56-byte Big-Endian SMPv1 binary protocol codec.
 * Byte-for-byte compatible with Kotlin SmpV1Codec.kt.
 *
 * Layout (56 bytes total):
 *   [0]      MAGIC_VER (0x51)
 *   [1]      FLAGS_TTL: bits 7..6 TriggerType, bit 5 ENV_STATE (1=POCKET/BAG), bit 4 SIREN_REQ, bits 3..0 TTL
 *   [2..9]   PACKET_ID (8 bytes)
 *   [10..11] SEQ_COUNTER (uint16 BE)
 *   [12..15] LATITUDE (int32 BE, degrees * 1e7)
 *   [16..19] LONGITUDE (int32 BE, degrees * 1e7)
 *   [20]     GPS_ACC_BATT: bits 7..4 gpsAccBucket (0..15), bits 3..0 batteryQuant (0..15)
 *   [21..22] AGE_SEC (uint16 BE)
 *   [23..26] SENDER_HINT (4 bytes)
 *   [27..28] POW_NONCE (uint16 BE)
 *   [29..37] SHORT_PAYLOAD (9 bytes UTF-8, zero-padded)
 *   [38..53] AUTH_SIG_128 (16 bytes lightweight MVP tag)
 *   [54..55] CRC16 CCITT-FALSE (poly 0x1021, init 0xFFFF) over bytes 0..53
 */

export const SMPV1_PACKET_SIZE = 56;
export const SMPV1_FRAME_HEADER_SIZE = 4;
export const SMPV1_FRAMED_SIZE = SMPV1_FRAME_HEADER_SIZE + SMPV1_PACKET_SIZE;
export const SMPV1_MAGIC_VER = 0x51;
export const SMPV1_ACOUSTIC_PREAMBLE = new Uint8Array([0xaa, 0xaa, 0x2d, 0xd4]);
export const SMPV1_SYNC_WORD = 0x2dd4;

export type TriggerType = "MANUAL" | "SENSOR_SOS" | "DAILY_RADAR" | "WITNESS_PIN";

const TRIGGER_TO_CODE: Record<TriggerType, number> = {
  MANUAL: 0,
  SENSOR_SOS: 1,
  DAILY_RADAR: 2,
  WITNESS_PIN: 3,
};

const CODE_TO_TRIGGER: TriggerType[] = [
  "MANUAL",
  "SENSOR_SOS",
  "DAILY_RADAR",
  "WITNESS_PIN",
];

export interface SmpV1Packet {
  triggerType: TriggerType;
  envPocketBag: boolean;
  sirenReq: boolean;
  ttl: number;            // 0..15
  packetId: string;       // 16 hex chars (8 bytes)
  seqCounter: number;     // 0..65535
  latitude: number;       // -90..90
  longitude: number;      // -180..180
  gpsAccBucket: number;   // 0..15
  batteryQuant: number;   // 0..15
  ageSec: number;         // 0..65535
  senderHint: string;     // 8 hex chars (4 bytes)
  powNonce: number;       // 0..65535
  shortPayload: string;   // <= 9 UTF-8 bytes
  authSig128Hex?: string; // 32 hex chars (16 bytes)
}

export interface DecodedSmpV1Result {
  ok: true;
  packet: SmpV1Packet;
  crc16: number;
  rawBytes: Uint8Array;
}

export interface DecodeSmpV1Error {
  ok: false;
  reason: "INVALID_LENGTH" | "INVALID_MAGIC" | "CRC_MISMATCH";
  message: string;
}

export function crc16CcittFalse(data: Uint8Array, offset = 0, length = data.length - offset): number {
  let crc = 0xffff;
  const end = offset + length;
  for (let i = offset; i < end; i++) {
    crc ^= (data[i] & 0xff) << 8;
    for (let bit = 0; bit < 8; bit++) {
      if ((crc & 0x8000) !== 0) {
        crc = ((crc << 1) ^ 0x1021) & 0xffff;
      } else {
        crc = (crc << 1) & 0xffff;
      }
    }
  }
  return crc & 0xffff;
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

export function hexToBytes(hex: string, expectedLen: number): Uint8Array {
  const clean = hex.replace(/[^0-9a-fA-F]/g, "").padStart(expectedLen * 2, "0").slice(0, expectedLen * 2);
  const out = new Uint8Array(expectedLen);
  for (let i = 0; i < expectedLen; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function randomHex(byteCount: number): string {
  const bytes = new Uint8Array(byteCount);
  if (typeof globalThis.crypto !== "undefined" && typeof globalThis.crypto.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < byteCount; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return bytesToHex(bytes);
}

/** Lightweight deterministic 16-byte MVP tag over header+payload bytes 0..37. */
function computeMvpAuthTag128(prefix38: Uint8Array): Uint8Array {
  const out = new Uint8Array(16);
  // Four independent FNV-1a 32-bit lanes seeded with distinct constants (zero async crypto deps).
  const seeds = [0x811c9dc5, 0x9e3779b9, 0x243f6a88, 0xb7e15162];
  const view = new DataView(out.buffer);
  for (let lane = 0; lane < 4; lane++) {
    let h = seeds[lane] >>> 0;
    for (let i = 0; i < prefix38.length; i++) {
      h ^= (prefix38[i] + lane * 31) & 0xff;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    view.setUint32(lane * 4, h, false);
  }
  return out;
}

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: false });

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

export function encodeSmpV1(pkt: SmpV1Packet): Uint8Array {
  const buf = new Uint8Array(SMPV1_PACKET_SIZE);
  const view = new DataView(buf.buffer);

  // [0] MAGIC_VER
  buf[0] = SMPV1_MAGIC_VER;

  // [1] FLAGS_TTL
  const triggerCode = TRIGGER_TO_CODE[pkt.triggerType] ?? 0;
  const ttl = clamp(Math.round(pkt.ttl), 0, 15);
  buf[1] =
    ((triggerCode & 0x03) << 6) |
    ((pkt.envPocketBag ? 1 : 0) << 5) |
    ((pkt.sirenReq ? 1 : 0) << 4) |
    (ttl & 0x0f);

  // [2..9] PACKET_ID (8 bytes)
  buf.set(hexToBytes(pkt.packetId, 8), 2);

  // [10..11] SEQ_COUNTER (uint16 BE)
  view.setUint16(10, clamp(Math.round(pkt.seqCounter), 0, 65535), false);

  // [12..15] LATITUDE (int32 BE * 1e7)
  const latInt = Math.round(clamp(pkt.latitude, -90, 90) * 1e7);
  view.setInt32(12, latInt, false);

  // [16..19] LONGITUDE (int32 BE * 1e7)
  const lonInt = Math.round(clamp(pkt.longitude, -180, 180) * 1e7);
  view.setInt32(16, lonInt, false);

  // [20] GPS_ACC_BATT
  const acc = clamp(Math.round(pkt.gpsAccBucket), 0, 15);
  const batt = clamp(Math.round(pkt.batteryQuant), 0, 15);
  buf[20] = ((acc & 0x0f) << 4) | (batt & 0x0f);

  // [21..22] AGE_SEC (uint16 BE)
  view.setUint16(21, clamp(Math.round(pkt.ageSec), 0, 65535), false);

  // [23..26] SENDER_HINT (4 bytes)
  buf.set(hexToBytes(pkt.senderHint, 4), 23);

  // [27..28] POW_NONCE (uint16 BE)
  view.setUint16(27, clamp(Math.round(pkt.powNonce), 0, 65535), false);

  // [29..37] SHORT_PAYLOAD (9 bytes UTF-8, zero-padded)
  const payloadBytes = utf8Encoder.encode(pkt.shortPayload ?? "").slice(0, 9);
  buf.set(payloadBytes, 29);

  // [38..53] AUTH_SIG_128 (16 bytes)
  const auth =
    pkt.authSig128Hex && pkt.authSig128Hex.length >= 32
      ? hexToBytes(pkt.authSig128Hex, 16)
      : computeMvpAuthTag128(buf.subarray(0, 38));
  buf.set(auth, 38);

  // [54..55] CRC16 CCITT-FALSE over bytes 0..53
  const crc = crc16CcittFalse(buf, 0, 54);
  view.setUint16(54, crc, false);

  return buf;
}

export function decodeSmpV1(raw: Uint8Array): DecodedSmpV1Result | DecodeSmpV1Error {
  if (raw.length !== SMPV1_PACKET_SIZE) {
    return {
      ok: false,
      reason: "INVALID_LENGTH",
      message: `Expected ${SMPV1_PACKET_SIZE} bytes, received ${raw.length}`,
    };
  }
  if (raw[0] !== SMPV1_MAGIC_VER) {
    return {
      ok: false,
      reason: "INVALID_MAGIC",
      message: `Invalid MAGIC_VER 0x${raw[0].toString(16).padStart(2, "0")}`,
    };
  }

  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const expectedCrc = crc16CcittFalse(raw, 0, 54);
  const actualCrc = view.getUint16(54, false);
  if (expectedCrc !== actualCrc) {
    return {
      ok: false,
      reason: "CRC_MISMATCH",
      message: `CRC16 mismatch: expected 0x${expectedCrc.toString(16).padStart(4, "0")}, got 0x${actualCrc.toString(16).padStart(4, "0")}`,
    };
  }

  const flagsTtl = raw[1];
  const triggerType = CODE_TO_TRIGGER[(flagsTtl >>> 6) & 0x03] ?? "MANUAL";
  const envPocketBag = ((flagsTtl >>> 5) & 0x01) === 1;
  const sirenReq = ((flagsTtl >>> 4) & 0x01) === 1;
  const ttl = flagsTtl & 0x0f;

  const packetId = bytesToHex(raw.subarray(2, 10));
  const seqCounter = view.getUint16(10, false);
  const latitude = view.getInt32(12, false) / 1e7;
  const longitude = view.getInt32(16, false) / 1e7;

  const gpsAccBatt = raw[20];
  const gpsAccBucket = (gpsAccBatt >>> 4) & 0x0f;
  const batteryQuant = gpsAccBatt & 0x0f;

  const ageSec = view.getUint16(21, false);
  const senderHint = bytesToHex(raw.subarray(23, 27));
  const powNonce = view.getUint16(27, false);

  const rawPayload = raw.subarray(29, 38);
  const zeroIdx = rawPayload.indexOf(0);
  const trimmedPayload = zeroIdx === -1 ? rawPayload : rawPayload.subarray(0, zeroIdx);
  const shortPayload = utf8Decoder.decode(trimmedPayload);

  const authSig128Hex = bytesToHex(raw.subarray(38, 54));

  return {
    ok: true,
    crc16: actualCrc,
    rawBytes: raw.slice(),
    packet: {
      triggerType,
      envPocketBag,
      sirenReq,
      ttl,
      packetId,
      seqCounter,
      latitude,
      longitude,
      gpsAccBucket,
      batteryQuant,
      ageSec,
      senderHint,
      powNonce,
      shortPayload,
      authSig128Hex,
    },
  };
}

export function frameForAcoustic(packet56: Uint8Array): Uint8Array {
  if (packet56.length !== SMPV1_PACKET_SIZE) {
    throw new Error(`Expected ${SMPV1_PACKET_SIZE}-byte SMPv1 packet`);
  }
  const out = new Uint8Array(SMPV1_FRAMED_SIZE);
  out.set(SMPV1_ACOUSTIC_PREAMBLE, 0);
  out.set(packet56, SMPV1_FRAME_HEADER_SIZE);
  return out;
}

/**
 * Prepares a relayed copy of a packet with TTL decremented by 1 and AGE_SEC incremented.
 * Returns null if TTL has reached 0 (store locally, do not re-broadcast).
 */
export function prepareRelayPacket(pkt: SmpV1Packet, elapsedSec = 1): Uint8Array | null {
  if (pkt.ttl <= 0) return null;
  const nextTtl = pkt.ttl - 1;
  if (nextTtl <= 0) return null;
  return encodeSmpV1({
    ...pkt,
    ttl: nextTtl,
    ageSec: Math.min(65535, pkt.ageSec + Math.max(1, Math.round(elapsedSec))),
  });
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

/**
 * Packet deduplication & anti-replay cache keyed by 8-byte PACKET_ID and per-sender SEQ_COUNTER.
 */
export class PacketDeduplicator {
  private readonly seen = new Map<string, number>();
  private readonly highestSeq = new Map<string, number>();

  constructor(
    private readonly maxEntries = 512,
    private readonly windowMs = 10 * 60 * 1000
  ) {}

  acceptIfFresh(pkt: SmpV1Packet, nowMs = Date.now()): boolean {
    const prev = this.seen.get(pkt.packetId);
    if (prev !== undefined && nowMs - prev < this.windowMs) {
      return false;
    }

    const lastSeq = this.highestSeq.get(pkt.senderHint);
    if (lastSeq !== undefined && pkt.seqCounter < lastSeq && lastSeq - pkt.seqCounter < 32768) {
      return false;
    }

    this.seen.set(pkt.packetId, nowMs);
    if (this.seen.size > this.maxEntries) {
      const oldestKey = this.seen.keys().next().value;
      if (oldestKey !== undefined) {
        this.seen.delete(oldestKey);
      }
    }

    if (lastSeq === undefined || pkt.seqCounter > lastSeq) {
      this.highestSeq.set(pkt.senderHint, pkt.seqCounter);
    }
    return true;
  }

  hydrateSeen(entries: Array<{ packetId: string; senderHint: string; seqCounter: number; seenAtMs: number }>) {
    for (const e of entries) {
      this.seen.set(e.packetId, e.seenAtMs);
      const prev = this.highestSeq.get(e.senderHint);
      if (prev === undefined || e.seqCounter > prev) {
        this.highestSeq.set(e.senderHint, e.seqCounter);
      }
    }
  }

  clear() {
    this.seen.clear();
    this.highestSeq.clear();
  }
}
