import { describe, expect, it } from "vitest";
import {
  SMPV1_ACOUSTIC_PREAMBLE,
  SMPV1_FRAMED_SIZE,
  SMPV1_MAGIC_VER,
  SMPV1_PACKET_SIZE,
  PacketDeduplicator,
  crc16CcittFalse,
  decodeSmpV1,
  encodeSmpV1,
  frameForAcoustic,
  prepareRelayPacket,
  type SmpV1Packet,
} from "./smpv1";
import {
  bearingDegrees,
  estimateDistanceFromRssi,
  haversineMeters,
} from "./geo";

function makeSamplePacket(overrides: Partial<SmpV1Packet> = {}): SmpV1Packet {
  return {
    triggerType: "SENSOR_SOS",
    envPocketBag: true,
    sirenReq: true,
    ttl: 4,
    packetId: "0123456789abcdef",
    seqCounter: 42,
    latitude: -7.257472,
    longitude: 112.752088,
    gpsAccBucket: 2,
    batteryQuant: 12,
    ageSec: 18,
    senderHint: "deadbeef",
    powNonce: 305,
    shortPayload: "HELP 2F!",
    ...overrides,
  };
}

describe("SMPv1 56-byte binary protocol", () => {
  it("computes standard CRC-16/CCITT-FALSE check value 0x29B1 for '123456789'", () => {
    const bytes = new TextEncoder().encode("123456789");
    expect(crc16CcittFalse(bytes)).toBe(0x29b1);
  });

  it("encodes and decodes exact 56 bytes in Big-Endian byte order", () => {
    const pkt = makeSamplePacket();
    const raw = encodeSmpV1(pkt);

    expect(raw.length).toBe(SMPV1_PACKET_SIZE);
    expect(raw[0]).toBe(SMPV1_MAGIC_VER);

    // Check FLAGS_TTL byte: SENSOR_SOS(01) << 6 | pocket(1) << 5 | siren(1) << 4 | ttl(4) = 0x74
    expect(raw[1]).toBe(0x74);

    // Check SEQ_COUNTER Big-Endian at offset 10..11 (42 = 0x002A)
    expect(raw[10]).toBe(0x00);
    expect(raw[11]).toBe(0x2a);

    const decoded = decodeSmpV1(raw);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;

    expect(decoded.packet.triggerType).toBe("SENSOR_SOS");
    expect(decoded.packet.envPocketBag).toBe(true);
    expect(decoded.packet.sirenReq).toBe(true);
    expect(decoded.packet.ttl).toBe(4);
    expect(decoded.packet.packetId).toBe("0123456789abcdef");
    expect(decoded.packet.seqCounter).toBe(42);
    expect(decoded.packet.latitude).toBeCloseTo(-7.257472, 6);
    expect(decoded.packet.longitude).toBeCloseTo(112.752088, 6);
    expect(decoded.packet.gpsAccBucket).toBe(2);
    expect(decoded.packet.batteryQuant).toBe(12);
    expect(decoded.packet.ageSec).toBe(18);
    expect(decoded.packet.senderHint).toBe("deadbeef");
    expect(decoded.packet.powNonce).toBe(305);
    expect(decoded.packet.shortPayload).toBe("HELP 2F!");
    expect(decoded.packet.authSig128Hex?.length).toBe(32);
  });

  it("rejects corrupted MAGIC_VER, wrong length, and any single-bit CRC corruption", () => {
    const raw = encodeSmpV1(makeSamplePacket());

    const badLen = decodeSmpV1(raw.subarray(0, 55));
    expect(badLen.ok).toBe(false);

    const badMagicBytes = raw.slice();
    badMagicBytes[0] = 0x52;
    const badMagic = decodeSmpV1(badMagicBytes);
    expect(badMagic.ok).toBe(false);
    if (!badMagic.ok) expect(badMagic.reason).toBe("INVALID_MAGIC");

    const flipped = raw.slice();
    flipped[31] ^= 0x04;
    const badCrc = decodeSmpV1(flipped);
    expect(badCrc.ok).toBe(false);
    if (!badCrc.ok) expect(badCrc.reason).toBe("CRC_MISMATCH");
  });

  it("prepends 4-byte acoustic preamble 0xAA 0xAA 0x2D 0xD4 for 60-byte framed output", () => {
    const raw = encodeSmpV1(makeSamplePacket());
    const framed = frameForAcoustic(raw);
    expect(framed.length).toBe(SMPV1_FRAMED_SIZE);
    expect(Array.from(framed.subarray(0, 4))).toEqual(Array.from(SMPV1_ACOUSTIC_PREAMBLE));
  });

  it("deduplicates duplicate PACKET_ID and stale per-sender SEQ_COUNTER", () => {
    const dedup = new PacketDeduplicator();
    const p1 = makeSamplePacket({ packetId: "aaaaaaaaaaaaaaaa", seqCounter: 10 });
    const p1Dup = makeSamplePacket({ packetId: "aaaaaaaaaaaaaaaa", seqCounter: 10 });
    const pStale = makeSamplePacket({ packetId: "bbbbbbbbbbbbbbbb", seqCounter: 9 });
    const pFresh = makeSamplePacket({ packetId: "cccccccccccccccc", seqCounter: 11 });

    expect(dedup.acceptIfFresh(p1, 1000)).toBe(true);
    expect(dedup.acceptIfFresh(p1Dup, 2000)).toBe(false);
    expect(dedup.acceptIfFresh(pStale, 3000)).toBe(false);
    expect(dedup.acceptIfFresh(pFresh, 4000)).toBe(true);
  });

  it("decrements TTL and increments AGE_SEC on relay and stops at TTL 0", () => {
    const pkt = makeSamplePacket({ ttl: 2, ageSec: 10 });
    const hop1 = prepareRelayPacket(pkt, 3);
    expect(hop1).not.toBeNull();
    const dec1 = decodeSmpV1(hop1!);
    expect(dec1.ok).toBe(true);
    if (!dec1.ok) return;
    expect(dec1.packet.ttl).toBe(1);
    expect(dec1.packet.ageSec).toBe(13);

    // Next hop reaches 0 -> must not relay
    expect(prepareRelayPacket(dec1.packet, 2)).toBeNull();
  });

  it("calculates offline Haversine distance, bearing, and RSSI range accurately", () => {
    // Move ~111m North
    const dist = haversineMeters(-7.257472, 112.752088, -7.256472, 112.752088);
    expect(dist).toBeGreaterThan(105);
    expect(dist).toBeLessThan(118);

    const brg = bearingDegrees(-7.257472, 112.752088, -7.256472, 112.752088);
    expect(brg).toBeCloseTo(0, 0);

    expect(estimateDistanceFromRssi(-59)).toBeCloseTo(1.0, 1);
    expect(estimateDistanceFromRssi(-83)).toBeGreaterThan(estimateDistanceFromRssi(-65));
  });
});
