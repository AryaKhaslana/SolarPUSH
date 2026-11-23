import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Svg, { Line, Rect, Text as SvgText } from "react-native-svg";
import type { NativeSpectrumFrame } from "sonarmesh-native";
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
const H = 128;
const PAD_L = 28;
const PAD_R = 8;
const PAD_T = 12;
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
  const barW = Math.max(2.5, barStep * 0.68);

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>18.5-20 kHz FFT Spectrum</Text>
          <Text style={styles.subtitle}>
            {listening
              ? `Peak ${Math.round(frame?.peakFreqHz ?? 0)} Hz · SNR ${(frame?.snrDb ?? 0).toFixed(1)} dB`
              : "Microphone idle (on-demand per FR-6)"}
          </Text>
        </View>

        <View style={styles.actions}>
          <Pressable
            onPress={onToggleListen}
            style={[styles.chipBtn, listening ? styles.chipBtnActive : null]}
            accessibilityRole="button"
          >
            <Text style={[styles.chipText, listening ? styles.chipTextActive : null]}>
              {listening ? "Stop Mic" : "Listen Mic"}
            </Text>
          </Pressable>
          <Pressable
            onPress={onCalibrate}
            disabled={calibrating}
            style={[styles.chipBtn, calibrating ? styles.chipBtnWarn : null]}
            accessibilityRole="button"
          >
            <Text style={[styles.chipText, calibrating ? styles.chipTextWarn : null]}>
              {calibrating ? "Calibrating 3s..." : "Calibrate 3s"}
            </Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.svgBox}>
        <Svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`}>
          {/* Grid */}
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

          {/* FSK Carrier vertical guides */}
          <Line x1={spaceX} y1={PAD_T} x2={spaceX} y2={PAD_T + PLOT_H} stroke={COLORS.amber} strokeWidth={1} strokeDasharray="3,3" />
          <Line x1={markX} y1={PAD_T} x2={markX} y2={PAD_T + PLOT_H} stroke={COLORS.sonar} strokeWidth={1} strokeDasharray="3,3" />

          {/* Noise floor and calibrated detection threshold */}
          <Line x1={PAD_L} y1={floorY} x2={W - PAD_R} y2={floorY} stroke={COLORS.muted} strokeWidth={1} strokeDasharray="2,3" />
          <Line x1={PAD_L} y1={threshY} x2={W - PAD_R} y2={threshY} stroke={COLORS.sos} strokeWidth={1} strokeDasharray="4,2" />

          {/* FFT Magnitude Bars */}
          {bins.map((db, idx) => {
            const y = dbToY(db);
            const h = Math.max(1.5, PAD_T + PLOT_H - y);
            const x = PAD_L + idx * barStep;
            const aboveThresh = db >= thresholdDb;
            return (
              <Rect
                key={idx}
                x={x}
                y={y}
                width={barW}
                height={h}
                rx={1}
                fill={aboveThresh ? COLORS.sonar : "#2C4257"}
              />
            );
          })}

          {/* X-axis frequency ticks */}
          <SvgText x={PAD_L} y={H - 6} fill={COLORS.muted} fontSize={9} textAnchor="start">
            18.2k
          </SvgText>
          <SvgText x={spaceX} y={H - 6} fill={COLORS.amber} fontSize={9} textAnchor="middle">
            0:{(freqSpace0Hz / 1000).toFixed(2)}k
          </SvgText>
          <SvgText x={markX} y={H - 6} fill={COLORS.sonar} fontSize={9} textAnchor="middle">
            1:{(freqMark1Hz / 1000).toFixed(2)}k
          </SvgText>
          <SvgText x={W - PAD_R} y={H - 6} fill={COLORS.muted} fontSize={9} textAnchor="end">
            20.2k
          </SvgText>
        </Svg>
      </View>

      <View style={styles.legendRow}>
        <Text style={styles.legendText}>
          Floor {(frame?.noiseFloorDb ?? -54).toFixed(1)} dB
        </Text>
        <Text style={styles.legendText}>
          Threshold {thresholdDb.toFixed(1)} dB
        </Text>
        <Text style={styles.legendText}>Sync 0x2DD4</Text>
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
    alignItems: "flex-start",
    gap: 8,
    marginBottom: 8,
  },
  title: {
    color: COLORS.text,
    fontSize: 13,
    fontWeight: "600",
  },
  subtitle: {
    color: COLORS.muted,
    fontSize: 11,
    marginTop: 2,
    fontVariant: ["tabular-nums"],
  },
  actions: {
    flexDirection: "row",
    gap: 6,
  },
  chipBtn: {
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.surfaceElevated,
  },
  chipBtnActive: {
    borderColor: COLORS.sonar,
    backgroundColor: COLORS.sonarSoft,
  },
  chipBtnWarn: {
    borderColor: COLORS.amber,
    backgroundColor: COLORS.amberSoft,
  },
  chipText: {
    color: COLORS.text,
    fontSize: 11,
    fontWeight: "600",
  },
  chipTextActive: {
    color: COLORS.sonar,
  },
  chipTextWarn: {
    color: COLORS.amber,
  },
  svgBox: {
    backgroundColor: COLORS.ground,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: COLORS.rule,
    overflow: "hidden",
  },
  legendRow: {
    marginTop: 8,
    flexDirection: "row",
    justifyContent: "space-between",
  },
  legendText: {
    color: COLORS.muted,
    fontSize: 11,
    fontVariant: ["tabular-nums"],
  },
});
