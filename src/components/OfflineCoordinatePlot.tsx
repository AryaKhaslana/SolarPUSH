import React from "react";
import { StyleSheet, Text, View } from "react-native";
import Svg, { Circle, Line, Text as SvgText } from "react-native-svg";
import {
  bearingDegrees,
  cardinalDirectionId,
  formatDistance,
  gpsAccuracyBucketLabel,
  haversineMeters,
} from "@/protocol/geo";
import type { StoredSosRecord } from "@/storage/packetStore";
import { COLORS } from "@/theme/tokens";

interface OfflineCoordinatePlotProps {
  myLat: number;
  myLon: number;
  myAccuracyM: number;
  records: StoredSosRecord[];
}

const W = 320;
const H = 196;
const CX = W / 2;
const CY = H / 2;
const MAX_M = 80;

export const OfflineCoordinatePlot = React.memo(function OfflineCoordinatePlot({
  myLat,
  myLon,
  myAccuracyM,
  records,
}: OfflineCoordinatePlotProps) {
  const points = records.slice(0, 15).map((rec) => {
    const dist = haversineMeters(myLat, myLon, rec.packet.latitude, rec.packet.longitude);
    const brg = bearingDegrees(myLat, myLon, rec.packet.latitude, rec.packet.longitude);
    const rad = ((brg - 90) * Math.PI) / 180;
    const scale = Math.min(78, (dist / MAX_M) * 78);
    return {
      rec,
      dist,
      brg,
      x: CX + Math.cos(rad) * scale,
      y: CY + Math.sin(rad) * scale,
    };
  });

  return (
    <View style={styles.wrap}>
      <View style={styles.fixCard}>
        <Text style={styles.fixLabel}>Koordinat GPS Offline Anda</Text>
        <Text style={styles.fixCoords}>
          {myLat.toFixed(6)}, {myLon.toFixed(6)}
        </Text>
        <Text style={styles.fixMeta}>
          Akurasi +/- {Math.round(myAccuracyM)} m · Tersimpan lokal tanpa peta online
        </Text>
      </View>

      <View style={styles.plotBox}>
        <Svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`}>
          <Line x1={0} y1={CY} x2={W} y2={CY} stroke={COLORS.rule} strokeWidth={1} />
          <Line x1={CX} y1={0} x2={CX} y2={H} stroke={COLORS.rule} strokeWidth={1} />
          <Circle cx={CX} cy={CY} r={39} stroke={COLORS.border} strokeWidth={1} fill="none" strokeDasharray="3,3" />
          <Circle cx={CX} cy={CY} r={78} stroke={COLORS.border} strokeWidth={1} fill="none" strokeDasharray="3,3" />

          <SvgText x={CX + 4} y={14} fill={COLORS.muted} fontSize={9}>
            Utara (80m)
          </SvgText>
          <SvgText x={W - 6} y={CY - 4} fill={COLORS.muted} fontSize={9} textAnchor="end">
            Timur
          </SvgText>

          {points.map((pt) => (
            <React.Fragment key={pt.rec.packetId}>
              <Circle cx={pt.x} cy={pt.y} r={5} fill={COLORS.sos} />
              <SvgText x={pt.x + 7} y={pt.y + 3} fill={COLORS.text} fontSize={9}>
                {pt.rec.packet.shortPayload || pt.rec.packet.senderHint.slice(0, 4).toUpperCase()}
              </SvgText>
            </React.Fragment>
          ))}

          <Circle cx={CX} cy={CY} r={5} fill={COLORS.sonar} />
          <SvgText x={CX + 8} y={CY + 14} fill={COLORS.sonar} fontSize={9} fontWeight="700">
            ANDA
          </SvgText>
        </Svg>
      </View>

      {points.length === 0 ? (
        <Text style={styles.emptyText}>
          Belum ada koordinat korban yang masuk. Sinyal SOS dengan GPS akan langsung muncul pada grid di atas.
        </Text>
      ) : (
        <View style={styles.table}>
          {points.map((pt) => (
            <View key={pt.rec.packetId} style={styles.row}>
              <View style={styles.rowLeft}>
                <Text style={styles.sender}>
                  {pt.rec.packet.shortPayload || "Sinyal SOS"} · {pt.rec.packet.senderHint.slice(0, 4).toUpperCase()}
                </Text>
                <Text style={styles.coordSmall}>
                  {pt.rec.packet.latitude.toFixed(5)}, {pt.rec.packet.longitude.toFixed(5)}
                </Text>
              </View>
              <View style={styles.rowRight}>
                <Text style={styles.distText}>
                  {formatDistance(pt.dist)} · {cardinalDirectionId(pt.brg)}
                </Text>
                <Text style={styles.accSmall}>
                  GPS {gpsAccuracyBucketLabel(pt.rec.packet.gpsAccBucket)}
                </Text>
              </View>
            </View>
          ))}
        </View>
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  wrap: {
    gap: 12,
  },
  fixCard: {
    backgroundColor: COLORS.surface,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
  },
  fixLabel: {
    color: COLORS.muted,
    fontSize: 12,
    fontWeight: "600",
  },
  fixCoords: {
    color: COLORS.sonar,
    fontSize: 16,
    fontWeight: "700",
    marginTop: 4,
    fontVariant: ["tabular-nums"],
  },
  fixMeta: {
    color: COLORS.muted,
    fontSize: 12,
    marginTop: 4,
  },
  plotBox: {
    backgroundColor: COLORS.ground,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: 12,
    overflow: "hidden",
  },
  emptyText: {
    color: COLORS.muted,
    fontSize: 12,
    lineHeight: 18,
    textAlign: "center",
    paddingVertical: 14,
  },
  table: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 12,
    overflow: "hidden",
  },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 11,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.rule,
    backgroundColor: COLORS.surface,
  },
  rowLeft: {
    gap: 3,
    flex: 1,
    paddingRight: 8,
  },
  rowRight: {
    alignItems: "flex-end",
    gap: 3,
  },
  sender: {
    color: COLORS.text,
    fontSize: 13,
    fontWeight: "600",
  },
  coordSmall: {
    color: COLORS.muted,
    fontSize: 11,
    fontVariant: ["tabular-nums"],
  },
  distText: {
    color: COLORS.sonar,
    fontSize: 13,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  accSmall: {
    color: COLORS.muted,
    fontSize: 11,
  },
});
