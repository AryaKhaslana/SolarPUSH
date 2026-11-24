import React from "react";
import { StyleSheet, Text, View } from "react-native";
import Svg, { Circle, Line, Path, Text as SvgText } from "react-native-svg";
import {
  batteryQuantToPct,
  bearingDegrees,
  cardinalDirectionId,
  estimateDistanceFromRssi,
  formatAgeId,
  formatDistance,
  haversineMeters,
  relativeBearing,
} from "@/protocol/geo";
import type { StoredSosRecord } from "@/storage/packetStore";
import { CARD_SHADOW, COLORS, FONTS } from "@/theme/tokens";

interface CompassRadarProps {
  headingDeg: number;
  myLat: number;
  myLon: number;
  records: StoredSosRecord[];
  selectedPacketId: string | null;
  onSelectPacket: (packetId: string) => void;
}

const SIZE = 252;
const CENTER = SIZE / 2;
const MAX_R = 98;
const MAX_RANGE_M = 60;

export const CompassRadar = React.memo(function CompassRadar({
  headingDeg,
  myLat,
  myLon,
  records,
  selectedPacketId,
  onSelectPacket,
}: CompassRadarProps) {
  const plotted = records.slice(0, 12).map((rec) => {
    const hasCoords =
      Math.abs(rec.packet.latitude) > 0.0001 || Math.abs(rec.packet.longitude) > 0.0001;
    const distM = hasCoords
      ? haversineMeters(myLat, myLon, rec.packet.latitude, rec.packet.longitude)
      : estimateDistanceFromRssi(rec.rssi);
    const trueBrg = hasCoords
      ? bearingDegrees(myLat, myLon, rec.packet.latitude, rec.packet.longitude)
      : (parseInt(rec.packet.senderHint.slice(0, 2), 16) / 255) * 360;
    const relBrg = relativeBearing(trueBrg, headingDeg);
    const clampedR = Math.min(MAX_R - 10, Math.max(16, (distM / MAX_RANGE_M) * MAX_R));
    const rad = ((relBrg - 90) * Math.PI) / 180;
    const x = CENTER + Math.cos(rad) * clampedR;
    const y = CENTER + Math.sin(rad) * clampedR;
    return { rec, distM, trueBrg, relBrg, x, y };
  });

  const selected =
    plotted.find((p) => p.rec.packetId === selectedPacketId) ?? plotted[0] ?? null;

  const cardinals = [
    { label: "U", deg: 0, isNorth: true },
    { label: "T", deg: 90, isNorth: false },
    { label: "S", deg: 180, isNorth: false },
    { label: "B", deg: 270, isNorth: false },
  ];

  const selectedAge = selected
    ? selected.rec.packet.ageSec +
      Math.max(0, Math.floor((Date.now() - selected.rec.receivedAtMs) / 1000))
    : 0;

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>Radar Arah Sinyal</Text>
          <Text style={styles.subtitle}>
            Menghadap {cardinalDirectionId(headingDeg)} ({Math.round(headingDeg)}°)
          </Text>
        </View>
        <View style={styles.countPill}>
          <Text style={styles.countPillText}>{records.length} sinyal</Text>
        </View>
      </View>

      <View style={styles.svgWrap}>
        <Svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`}>
          {/* Soft light radar dial */}
          <Circle cx={CENTER} cy={CENTER} r={MAX_R} stroke={COLORS.borderStrong} strokeWidth={1.2} fill={COLORS.ground} />
          <Circle cx={CENTER} cy={CENTER} r={MAX_R * 0.66} stroke={COLORS.border} strokeWidth={1} fill="none" />
          <Circle cx={CENTER} cy={CENTER} r={MAX_R * 0.33} stroke={COLORS.border} strokeWidth={1} fill="none" />

          <SvgText x={CENTER + 4} y={CENTER - MAX_R * 0.33 + 11} fill={COLORS.muted} fontSize={9}>
            20m
          </SvgText>
          <SvgText x={CENTER + 4} y={CENTER - MAX_R * 0.66 + 11} fill={COLORS.muted} fontSize={9}>
            40m
          </SvgText>

          <Line x1={CENTER} y1={CENTER - MAX_R} x2={CENTER} y2={CENTER + MAX_R} stroke={COLORS.border} strokeWidth={1} />
          <Line x1={CENTER - MAX_R} y1={CENTER} x2={CENTER + MAX_R} y2={CENTER} stroke={COLORS.border} strokeWidth={1} />

          {/* Forward scan beam */}
          <Path
            d={`M ${CENTER} ${CENTER} L ${CENTER - 28} ${CENTER - MAX_R + 5} A ${MAX_R} ${MAX_R} 0 0 1 ${CENTER + 28} ${CENTER - MAX_R + 5} Z`}
            fill={COLORS.sonar}
            fillOpacity={0.12}
          />

          {/* Rotating compass cardinals */}
          {cardinals.map((c) => {
            const rel = relativeBearing(c.deg, headingDeg);
            const rad = ((rel - 90) * Math.PI) / 180;
            const lx = CENTER + Math.cos(rad) * (MAX_R + 15);
            const ly = CENTER + Math.sin(rad) * (MAX_R + 15) + 4;
            return (
              <SvgText
                key={c.label}
                x={lx}
                y={ly}
                fill={c.isNorth ? COLORS.sosFill : COLORS.muted}
                fontSize={11}
                fontWeight="700"
                textAnchor="middle"
              >
                {c.label}
              </SvgText>
            );
          })}

          {selected ? (
            <Line
              x1={CENTER}
              y1={CENTER}
              x2={selected.x}
              y2={selected.y}
              stroke={COLORS.sosFill}
              strokeWidth={1.6}
              strokeDasharray="5,3"
            />
          ) : null}

          {plotted.map((pt) => {
            const isSel = selected?.rec.packetId === pt.rec.packetId;
            const dotColor =
              pt.rec.packet.triggerType === "DAILY_RADAR" ? COLORS.sonar : COLORS.sosFill;
            return (
              <React.Fragment key={pt.rec.packetId}>
                {isSel ? (
                  <Circle
                    cx={pt.x}
                    cy={pt.y}
                    r={13}
                    stroke={dotColor}
                    strokeWidth={1.5}
                    fill={dotColor}
                    fillOpacity={0.14}
                    onPress={() => onSelectPacket(pt.rec.packetId)}
                  />
                ) : null}
                <Circle
                  cx={pt.x}
                  cy={pt.y}
                  r={isSel ? 6 : 4.5}
                  fill={dotColor}
                  onPress={() => onSelectPacket(pt.rec.packetId)}
                />
              </React.Fragment>
            );
          })}

          <Circle cx={CENTER} cy={CENTER} r={5.5} fill={COLORS.sonar} />
          <Circle cx={CENTER} cy={CENTER} r={2} fill={COLORS.white} />
        </Svg>
      </View>

      {selected ? (
        <View style={styles.targetBox}>
          <View style={styles.targetLeft}>
            <Text style={styles.targetDistance}>{formatDistance(selected.distM)}</Text>
            <Text style={styles.targetDir}>
              {cardinalDirectionId(selected.trueBrg)} · {Math.round(selected.trueBrg)}°
            </Text>
          </View>
          <View style={styles.targetRight}>
            <Text style={styles.targetNote} numberOfLines={1}>
              {selected.rec.packet.shortPayload || "Sinyal SOS"}
            </Text>
            <Text style={styles.targetMeta}>
              {selected.rec.packet.envPocketBag ? "Di saku/tas" : "Ruang terbuka"} · Baterai{" "}
              {batteryQuantToPct(selected.rec.packet.batteryQuant)}% · {formatAgeId(selectedAge)}
            </Text>
          </View>
        </View>
      ) : (
        <View style={styles.emptyFooter}>
          <Text style={styles.emptyFooterText}>
            Belum ada sinyal SOS terdeteksi di sekitar. Arahkan ponsel pelan untuk memindai.
          </Text>
        </View>
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  card: {
    backgroundColor: COLORS.surface,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: 16,
    padding: 16,
    ...CARD_SHADOW,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8,
  },
  title: {
    fontFamily: FONTS.sansMedium,
    color: COLORS.text,
    fontSize: 15,
    fontWeight: "700",
  },
  subtitle: {
    fontFamily: FONTS.sans,
    color: COLORS.muted,
    fontSize: 12,
    marginTop: 2,
    fontVariant: ["tabular-nums"],
  },
  countPill: {
    backgroundColor: COLORS.sonarSoft,
    borderColor: COLORS.sonarBorder,
    borderWidth: 1,
    borderRadius: 20,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  countPillText: {
    fontFamily: FONTS.sansMedium,
    color: COLORS.sonarDark,
    fontSize: 12,
    fontWeight: "600",
    fontVariant: ["tabular-nums"],
  },
  svgWrap: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 4,
  },
  targetBox: {
    marginTop: 12,
    backgroundColor: COLORS.surfaceSubtle,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  targetLeft: {
    paddingRight: 12,
    borderRightWidth: 1,
    borderRightColor: COLORS.borderStrong,
  },
  targetDistance: {
    fontFamily: FONTS.sansMedium,
    color: COLORS.text,
    fontSize: 20,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  targetDir: {
    fontFamily: FONTS.sansMedium,
    color: COLORS.sonarDark,
    fontSize: 11,
    fontWeight: "600",
    marginTop: 2,
  },
  targetRight: {
    flex: 1,
    gap: 3,
  },
  targetNote: {
    fontFamily: FONTS.sansMedium,
    color: COLORS.text,
    fontSize: 14,
    fontWeight: "700",
  },
  targetMeta: {
    fontFamily: FONTS.sans,
    color: COLORS.muted,
    fontSize: 11,
    lineHeight: 16,
  },
  emptyFooter: {
    marginTop: 10,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: COLORS.rule,
  },
  emptyFooterText: {
    fontFamily: FONTS.sans,
    color: COLORS.muted,
    fontSize: 12,
    lineHeight: 18,
    textAlign: "center",
  },
});
