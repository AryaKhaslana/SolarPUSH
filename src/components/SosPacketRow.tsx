import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import {
  batteryQuantToPct,
  bearingDegrees,
  cardinalDirectionId,
  formatAgeId,
  formatDistance,
  gpsAccuracyBucketLabel,
  haversineMeters,
} from "@/protocol/geo";
import type { TriggerType } from "@/protocol/smpv1";
import type { StoredSosRecord } from "@/storage/packetStore";
import { COLORS } from "@/theme/tokens";

interface SosPacketRowProps {
  record: StoredSosRecord;
  selected: boolean;
  myLat: number;
  myLon: number;
  onSelect: (packetId: string) => void;
}

const TRIGGER_LABELS_ID: Record<TriggerType, string> = {
  MANUAL: "SOS Manual",
  SENSOR_SOS: "Deteksi Benturan",
  DAILY_RADAR: "Ping Radar",
  WITNESS_PIN: "Tanda Saksi",
};

export const SosPacketRow = React.memo(function SosPacketRow({
  record,
  selected,
  myLat,
  myLon,
  onSelect,
}: SosPacketRowProps) {
  const { packet } = record;
  const dist = haversineMeters(myLat, myLon, packet.latitude, packet.longitude);
  const brg = bearingDegrees(myLat, myLon, packet.latitude, packet.longitude);
  const battPct = batteryQuantToPct(packet.batteryQuant);
  const ageNowSec =
    packet.ageSec + Math.max(0, Math.floor((Date.now() - record.receivedAtMs) / 1000));
  const isSos = packet.triggerType !== "DAILY_RADAR";

  return (
    <Pressable
      onPress={() => onSelect(record.packetId)}
      style={[styles.card, selected ? styles.cardSelected : null]}
      accessibilityRole="button"
    >
      <View style={styles.topRow}>
        <View style={styles.titleCol}>
          <Text style={styles.noteText} numberOfLines={1}>
            {packet.shortPayload || "Sinyal SOS Darurat"}
          </Text>
          <Text style={styles.ageSub}>
            Pengirim {packet.senderHint.slice(0, 4).toUpperCase()} · {formatAgeId(ageNowSec)}
          </Text>
        </View>

        <View style={styles.distCol}>
          <Text style={styles.distValue}>{formatDistance(dist)}</Text>
          <Text style={styles.dirLabel}>{cardinalDirectionId(brg)}</Text>
        </View>
      </View>

      <View style={styles.badgeRow}>
        <View style={[styles.badge, isSos ? styles.badgeSos : styles.badgeSonar]}>
          <Text style={[styles.badgeText, isSos ? styles.textSos : styles.textSonar]}>
            {TRIGGER_LABELS_ID[packet.triggerType]}
          </Text>
        </View>

        {packet.envPocketBag ? (
          <View style={[styles.badge, styles.badgeAmber]}>
            <Text style={[styles.badgeText, styles.textAmber]}>Di Saku / Tas</Text>
          </View>
        ) : null}

        {packet.sirenReq ? (
          <View style={[styles.badge, styles.badgeSos]}>
            <Text style={[styles.badgeText, styles.textSos]}>Minta Sirene</Text>
          </View>
        ) : null}

        <View style={[styles.badge, styles.badgeNeutral]}>
          <Text style={[styles.badgeText, styles.textMuted]}>
            {record.transport === "ultrasonic" ? "Suara 19 kHz" : "BLE"}
          </Text>
        </View>
      </View>

      <View style={styles.bottomRow}>
        <Text style={styles.metaText}>
          Baterai {battPct}% · GPS {gpsAccuracyBucketLabel(packet.gpsAccBucket)} · Sisa hop {packet.ttl}
        </Text>
        <Text style={styles.metaText}>{record.rssi} dBm</Text>
      </View>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  card: {
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
    gap: 10,
  },
  cardSelected: {
    borderColor: COLORS.sonar,
    backgroundColor: COLORS.surfaceElevated,
  },
  topRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 12,
  },
  titleCol: {
    flex: 1,
  },
  noteText: {
    color: COLORS.text,
    fontSize: 15,
    fontWeight: "700",
  },
  ageSub: {
    color: COLORS.muted,
    fontSize: 12,
    marginTop: 2,
  },
  distCol: {
    alignItems: "flex-end",
  },
  distValue: {
    color: COLORS.text,
    fontSize: 16,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  dirLabel: {
    color: COLORS.sonar,
    fontSize: 11,
    fontWeight: "600",
    marginTop: 1,
  },
  badgeRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  badgeSos: { backgroundColor: COLORS.sosSoft },
  badgeSonar: { backgroundColor: COLORS.sonarSoft },
  badgeAmber: { backgroundColor: COLORS.amberSoft },
  badgeNeutral: { backgroundColor: COLORS.surfaceElevated },
  badgeText: {
    fontSize: 11,
    fontWeight: "600",
  },
  textSos: { color: COLORS.sos },
  textSonar: { color: COLORS.sonar },
  textAmber: { color: COLORS.amber },
  textMuted: { color: COLORS.muted },
  bottomRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    borderTopWidth: 1,
    borderTopColor: COLORS.rule,
    paddingTop: 8,
  },
  metaText: {
    color: COLORS.muted,
    fontSize: 11,
    fontVariant: ["tabular-nums"],
  },
});
