import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Svg, { Line, Rect, Text as SvgText } from "react-native-svg";
import type { NativeSpectrumFrame } from "sonarmesh-native";
import { IconMic } from "@/components/Icons";
import { COLORS } from "@/theme/tokens";

interface SpectrumAnalyzerProps {
  frame: NativeSpectrumFrame | null;
  listening: boolean;
  calibrating: boolean;
  freqSpace0Hz: number;
  freqMark1Hz: number;
  thresholdDb: number;
  onToggleListen: () => void;
  onCalibrate: () => void;
}

const W = 320;
const H = 118;
const PAD_L = 28;
const PAD_R = 8;
const PAD_T = 10;
const PAD_B = 22;
const PLOT_W = W - PAD_L - PAD_R;
const PLOT_H = H - PAD_T - PAD_B;
const MIN_DB = -80;
const MAX_DB = -10;

function dbToY(db: number): number {
  const clamped = Math.min(MAX_DB, Math.max(MIN_DB, db));
  const ratio = (clamped - MIN_DB) / (MAX_DB - MIN_DB);
  return PAD_T + PLOT_H * (1 - ratio);
}

export const SpectrumAnalyzer = React.memo(function SpectrumAnalyzer({
  frame,
  listening,
  calibrating,
  freqSpace0Hz,
  freqMark1Hz,
  thresholdDb,
  onToggleListen,
  onCalibrate,
}: SpectrumAnalyzerProps) {
  const startHz = frame?.startFreqHz ?? 18200;
  const endHz = frame?.endFreqHz ?? 20200;
  const bins = frame?.binsDb ?? [];

  const freqToX = (hz: number) =>
    PAD_L + ((hz - startHz) / Math.max(1, endHz - startHz)) * PLOT_W;

  const spaceX = freqToX(freqSpace0Hz);
  const markX = freqToX(freqMark1Hz);
  const floorY = dbToY(frame?.noiseFloorDb ?? -54);
  const threshY = dbToY(thresholdDb);
  const barStep = bins.length > 0 ? PLOT_W / bins.length : PLOT_W / 32;
  const barW = Math.max(3, barStep * 0.65);

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <View style={styles.titleCol}>
          <Text style={styles.title}>Spektrum Ultrasonik (18,5-20 kHz)</Text>
          <Text style={styles.subtitle}>
            {listening
              ? `Aktif · Puncak ${( (frame?.peakFreqHz ?? 0) / 1000 ).toFixed(2)} kHz · SNR ${(frame?.snrDb ?? 0).toFixed(1)} dB`
              : "Mikrofon siaga untuk hemat baterai"}
          </Text>
        </View>
      </View>

      <View style={styles.svgBox}>
        <Svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`}>
          {[-70, -50, -30].map((db) => {
            const y = dbToY(db);
            return (
              <React.Fragment key={db}>
                <Line x1={PAD_L} y1={y} x2={W - PAD_R} y2={y} stroke={COLORS.rule} strokeWidth={1} />
                <SvgText x={PAD_L - 4} y={y + 3} fill={COLORS.muted} fontSize={9} textAnchor="end">
                  {db}
                </SvgText>
              </React.Fragment>
            );
          })}

          <Line x1={spaceX} y1={PAD_T} x2={spaceX} y2={PAD_T + PLOT_H} stroke={COLORS.amber} strokeWidth={1} strokeDasharray="3,3" />
          <Line x1={markX} y1={PAD_T} x2={markX} y2={PAD_T + PLOT_H} stroke={COLORS.sonar} strokeWidth={1} strokeDasharray="3,3" />
          <Line x1={PAD_L} y1={floorY} x2={W - PAD_R} y2={floorY} stroke={COLORS.muted} strokeWidth={1} strokeDasharray="2,3" />
          <Line x1={PAD_L} y1={threshY} x2={W - PAD_R} y2={threshY} stroke={COLORS.sos} strokeWidth={1} strokeDasharray="4,2" />

          {bins.map((db, idx) => {
            const y = dbToY(db);
            const h = Math.max(2, PAD_T + PLOT_H - y);
            const x = PAD_L + idx * barStep;
            const aboveThresh = db >= thresholdDb;
            return (
              <Rect
                key={idx}
                x={x}
                y={y}
                width={barW}
                height={h}
                rx={1.5}
                fill={aboveThresh ? COLORS.sonar : "#24374A"}
              />
            );
          })}

          <SvgText x={PAD_L} y={H - 6} fill={COLORS.muted} fontSize={9} textAnchor="start">
            18.2k
          </SvgText>
          <SvgText x={spaceX} y={H - 6} fill={COLORS.amber} fontSize={9} textAnchor="middle">
            {(freqSpace0Hz / 1000).toFixed(2)}k
          </SvgText>
          <SvgText x={markX} y={H - 6} fill={COLORS.sonar} fontSize={9} textAnchor="middle">
            {(freqMark1Hz / 1000).toFixed(2)}k
          </SvgText>
          <SvgText x={W - PAD_R} y={H - 6} fill={COLORS.muted} fontSize={9} textAnchor="end">
            20.2k
          </SvgText>
        </Svg>
      </View>

      <View style={styles.btnRow}>
        <Pressable
          onPress={onToggleListen}
          style={[styles.actionBtn, listening ? styles.actionBtnActive : null]}
          accessibilityRole="button"
        >
          <IconMic color={listening ? COLORS.sonar : COLORS.text} size={15} />
          <Text style={[styles.actionText, listening ? styles.actionTextActive : null]}>
            {listening ? "Matikan Mic" : "Dengar Sinyal Suara"}
          </Text>
        </Pressable>

        <Pressable
          onPress={onCalibrate}
          disabled={calibrating}
          style={[styles.actionBtn, calibrating ? styles.actionBtnWarn : null]}
          accessibilityRole="button"
        >
          <Text style={[styles.actionText, calibrating ? styles.actionTextWarn : null]}>
            {calibrating ? "Mengukur 3 dtk..." : "Kalibrasi 3 Detik"}
          </Text>
        </Pressable>
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  card: {
    backgroundColor: COLORS.surface,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: 14,
    padding: 16,
    gap: 10,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  titleCol: {
    flex: 1,
  },
  title: {
    color: COLORS.text,
    fontSize: 15,
    fontWeight: "700",
  },
  subtitle: {
    color: COLORS.muted,
    fontSize: 12,
    marginTop: 2,
    fontVariant: ["tabular-nums"],
  },
  svgBox: {
    backgroundColor: COLORS.ground,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.rule,
    overflow: "hidden",
  },
  btnRow: {
    flexDirection: "row",
    gap: 8,
  },
  actionBtn: {
    flex: 1,
    minHeight: 42,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.surfaceElevated,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingHorizontal: 10,
  },
  actionBtnActive: {
    borderColor: COLORS.sonar,
    backgroundColor: COLORS.sonarSoft,
  },
  actionBtnWarn: {
    borderColor: COLORS.amber,
    backgroundColor: COLORS.amberSoft,
  },
  actionText: {
    color: COLORS.text,
    fontSize: 12,
    fontWeight: "600",
  },
  actionTextActive: {
    color: COLORS.sonar,
  },
  actionTextWarn: {
    color: COLORS.amber,
  },
});
