import React from "react";
import { StyleSheet, Text, View } from "react-native";
import Svg, { Circle, Line, Path, Text as SvgText } from "react-native-svg";
import {
  bearingDegrees,
  estimateDistanceFromRssi,
  formatDistance,
  haversineMeters,
  relativeBearing,
} from "@/protocol/geo";
import type { StoredSosRecord } from "@/storage/packetStore";
import { COLORS } from "@/theme/tokens";

interface CompassRadarProps {
  headingDeg: number;
  myLat: number;
  myLon: number;
  records: StoredSosRecord[];
  selectedPacketId: string | null;
  onSelectPacket: (packetId: string) => void;
}

const SIZE = 224;
const CENTER = SIZE / 2;
const MAX_R = 88;
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
    const clampedR = Math.min(MAX_R - 8, Math.max(12, (distM / MAX_RANGE_M) * MAX_R));
    const rad = ((relBrg - 90) * Math.PI) / 180;
    const x = CENTER + Math.cos(rad) * clampedR;
    const y = CENTER + Math.sin(rad) * clampedR;
    return { rec, distM, trueBrg, relBrg, x, y };
  });

  const selected =
    plotted.find((p) => p.rec.packetId === selectedPacketId) ?? plotted[0] ?? null;

  const cardinals = [
    { label: "N", deg: 0 },
    { label: "E", deg: 90 },
    { label: "S", deg: 180 },
    { label: "W", deg: 270 },
  ];

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Text style={styles.title}>Relative Compass Radar</Text>
        <Text style={styles.monoReadout}>
          HDG {Math.round(headingDeg).toString().padStart(3, "0")}°
        </Text>
      </View>

      <View style={styles.svgWrap}>
        <Svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`}>
          {/* Range rings: 20m, 40m, 60m */}
          <Circle cx={CENTER} cy={CENTER} r={MAX_R} stroke={COLORS.border} strokeWidth={1} fill={COLORS.ground} />
          <Circle cx={CENTER} cy={CENTER} r={MAX_R * 0.66} stroke={COLORS.rule} strokeWidth={1} fill="none" />
          <Circle cx={CENTER} cy={CENTER} r={MAX_R * 0.33} stroke={COLORS.rule} strokeWidth={1} fill="none" />

          {/* Crosshair */}
          <Line x1={CENTER} y1={CENTER - MAX_R} x2={CENTER} y2={CENTER + MAX_R} stroke={COLORS.rule} strokeWidth={1} />
          <Line x1={CENTER - MAX_R} y1={CENTER} x2={CENTER + MAX_R} y2={CENTER} stroke={COLORS.rule} strokeWidth={1} />

          {/* Forward phone heading cone */}
          <Path
            d={`M ${CENTER} ${CENTER} L ${CENTER - 22} ${CENTER - MAX_R + 4} A ${MAX_R} ${MAX_R} 0 0 1 ${CENTER + 22} ${CENTER - MAX_R + 4} Z`}
            fill={COLORS.sonar}
            fillOpacity={0.09}
          />

          {/* Rotating cardinal markers */}
          {cardinals.map((c) => {
            const rel = relativeBearing(c.deg, headingDeg);
            const rad = ((rel - 90) * Math.PI) / 180;
            const lx = CENTER + Math.cos(rad) * (MAX_R + 13);
            const ly = CENTER + Math.sin(rad) * (MAX_R + 13) + 4;
            return (
              <SvgText
                key={c.label}
                x={lx}
                y={ly}
                fill={c.label === "N" ? COLORS.sos : COLORS.muted}
                fontSize={10}
                fontWeight="700"
                textAnchor="middle"
              >
                {c.label}
              </SvgText>
            );
          })}

          {/* Bearing vector to selected node */}
          {selected ? (
            <Line
              x1={CENTER}
              y1={CENTER}
              x2={selected.x}
              y2={selected.y}
              stroke={COLORS.sos}
              strokeWidth={1.5}
              strokeDasharray="4,3"
            />
          ) : null}

          {/* Plotted SOS targets */}
          {plotted.map((pt) => {
            const isSel = selected?.rec.packetId === pt.rec.packetId;
            const dotColor =
              pt.rec.packet.triggerType === "DAILY_RADAR" ? COLORS.sonar : COLORS.sos;
            return (
              <React.Fragment key={pt.rec.packetId}>
                {isSel ? (
                  <Circle
                    cx={pt.x}
                    cy={pt.y}
                    r={10}
                    stroke={dotColor}
                    strokeWidth={1.5}
                    fill={dotColor}
                    fillOpacity={0.18}
                    onPress={() => onSelectPacket(pt.rec.packetId)}
                  />
                ) : null}
                <Circle
                  cx={pt.x}
                  cy={pt.y}
                  r={isSel ? 5 : 4}
                  fill={dotColor}
                  onPress={() => onSelectPacket(pt.rec.packetId)}
                />
              </React.Fragment>
            );
          })}

          {/* Center self node */}
          <Circle cx={CENTER} cy={CENTER} r={4} fill={COLORS.sonar} />
        </Svg>
      </View>

      <View style={styles.footer}>
        {selected ? (
          <Text style={styles.footerText} numberOfLines={1}>
            Target {selected.rec.packet.senderHint.toUpperCase()} ·{" "}
            {formatDistance(selected.distM)} · BRG {Math.round(selected.trueBrg)}° ·{" "}
            {selected.rec.rssi} dBm
          </Text>
        ) : (
          <Text style={styles.footerMuted}>
            No active SOS nodes plotted yet. Listening on BLE &amp; 18.5-20 kHz.
          </Text>
        )}
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  card: {
    backgroundColor: COLORS.surface,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8,
  },
  title: {
    color: COLORS.text,
    fontSize: 13,
    fontWeight: "600",
  },
  monoReadout: {
    color: COLORS.sonar,
    fontSize: 12,
    fontWeight: "600",
    fontVariant: ["tabular-nums"],
  },
  svgWrap: {
    alignItems: "center",
    justifyContent: "center",
  },
  footer: {
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: COLORS.rule,
  },
  footerText: {
    color: COLORS.text,
    fontSize: 12,
    fontVariant: ["tabular-nums"],
  },
  footerMuted: {
    color: COLORS.muted,
    fontSize: 12,
  },
});
