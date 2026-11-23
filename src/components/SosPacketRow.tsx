import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import {
  batteryQuantToPct,
  bearingDegrees,
  formatDistance,
  gpsAccuracyBucketLabel,
  haversineMeters,
} from "@/protocol/geo";
import type { StoredSosRecord } from "@/storage/packetStore";
import { COLORS } from "@/theme/tokens";

interface SosPacketRowProps {
  record: StoredSosRecord;
  selected: boolean;
  myLat: number;
  myLon: number;
  onSelect: (packetId: string) => void;
}

export const SosPacketRow = React.memo(function SosPacketRow({
  record,
  selected,
  myLat,
  myLon,
  onSelect,
}: SosPacketRowProps) {
  const { packet } = record;
  const dist = haversineMeters(myLat, myLon, packet.latitude, packet.longitude);
  const brg = Math.round(bearingDegrees(myLat, myLon, packet.latitude, packet.longitude));
  const battPct = batteryQuantToPct(packet.batteryQuant);
  const ageNowSec =
    packet.ageSec + Math.max(0, Math.floor((Date.now() - record.receivedAtMs) / 1000));

  return (
    <Pressable
      onPress={() => onSelect(record.packetId)}
      style={[styles.row, selected ? styles.rowSelected : null]}
      accessibilityRole="button"
    >
      <View style={styles.topLine}>
        <View style={styles.badgeGroup}>
          <View
            style={[
              styles.badge,
              packet.triggerType === "DAILY_RADAR" ? styles.badgeSonar : styles.badgeSos,
            ]}
          >
            <Text
              style={[
                styles.badgeText,
                packet.triggerType === "DAILY_RADAR" ? styles.textSonar : styles.textSos,
              ]}
            >
              {packet.triggerType}
            </Text>
          </View>

          <View style={[styles.badge, packet.envPocketBag ? styles.badgeAmber : styles.badgeNeutral]}>
            <Text style={[styles.badgeText, packet.envPocketBag ? styles.textAmber : styles.textMuted]}>
              {packet.envPocketBag ? "POCKET/BAG" : "OPEN"}
            </Text>
          </View>

          {packet.sirenReq ? (
            <View style={[styles.badge, styles.badgeSos]}>
              <Text style={[styles.badgeText, styles.textSos]}>SIREN_REQ</Text>
            </View>
          ) : null}

          <View style={[styles.badge, styles.badgeNeutral]}>
            <Text style={[styles.badgeText, styles.textMuted]}>
              {record.transport.toUpperCase()}
            </Text>
          </View>
        </View>

        <Text style={styles.distance}>
          {formatDistance(dist)} · {brg}°
        </Text>
      </View>

      <View style={styles.midLine}>
        <Text style={styles.payloadText} numberOfLines={1}>
          {packet.shortPayload ? `"${packet.shortPayload}"` : "(empty note)"}
        </Text>
        <Text style={styles.senderText}>
          NODE {packet.senderHint.toUpperCase()} · #{packet.seqCounter}
        </Text>
      </View>

      <View style={styles.metaLine}>
        <Text style={styles.metaText}>
          ID {packet.packetId.slice(0, 8)} · TTL {packet.ttl} · AGE {ageNowSec}s
        </Text>
        <Text style={styles.metaText}>
          BATT {battPct}% · GPS {gpsAccuracyBucketLabel(packet.gpsAccBucket)} · {record.rssi} dBm
        </Text>
      </View>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  row: {
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 8,
    padding: 10,
    marginBottom: 8,
    gap: 6,
  },
  rowSelected: {
    borderColor: COLORS.sonar,
    backgroundColor: COLORS.surfaceElevated,
  },
  topLine: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 6,
  },
  badgeGroup: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 4,
    flex: 1,
  },
  badge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  badgeSos: {
    backgroundColor: COLORS.sosSoft,
  },
  badgeSonar: {
    backgroundColor: COLORS.sonarSoft,
  },
  badgeAmber: {
    backgroundColor: COLORS.amberSoft,
  },
  badgeNeutral: {
    backgroundColor: COLORS.surfaceElevated,
  },
  badgeText: {
    fontSize: 10,
    fontWeight: "700",
  },
  textSos: {
    color: COLORS.sos,
  },
  textSonar: {
    color: COLORS.sonar,
  },
  textAmber: {
    color: COLORS.amber,
  },
  textMuted: {
    color: COLORS.muted,
  },
  distance: {
    color: COLORS.text,
    fontSize: 12,
    fontWeight: "600",
    fontVariant: ["tabular-nums"],
  },
  midLine: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 8,
  },
  payloadText: {
    color: COLORS.text,
    fontSize: 13,
    fontWeight: "600",
    flex: 1,
  },
  senderText: {
    color: COLORS.sonar,
    fontSize: 11,
    fontWeight: "600",
    fontVariant: ["tabular-nums"],
  },
  metaLine: {
    flexDirection: "row",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: 4,
  },
  metaText: {
    color: COLORS.muted,
    fontSize: 11,
    fontVariant: ["tabular-nums"],
  },
});
