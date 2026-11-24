import React, { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { SonarMeshSettings } from "@/config/sonarmeshConfig";
import type { PermissionKey, PermissionSnapshot } from "@/permissions/androidPermissions";
import type { StoredSosRecord } from "@/storage/packetStore";
import { IconCheck } from "@/components/Icons";
import { CARD_SHADOW, COLORS, FONTS } from "@/theme/tokens";

interface SettingsScreenProps {
  permissions: PermissionSnapshot;
  requestingPermission: boolean;
  settings: SonarMeshSettings;
  accelMs2: number;
  lightLux: number;
  isPocketBag: boolean;
  runtimeLabel: string;
  senderHint: string;
  relayedCount: number;
  rejectedCount: number;
  selectedRecord: StoredSosRecord | null;
  selectedHex: string;
  onRequestPermission: (key: PermissionKey) => Promise<void>;
  onUpdateSetting: <K extends keyof SonarMeshSettings>(
    key: K,
    value: SonarMeshSettings[K]
  ) => void;
  onSimulateImpact: () => void;
  onTogglePocketSim: () => void;
  onInjectBle: () => void;
  onInjectUltrasonic: () => void;
  onRotateCompass: () => void;
  onClearHistory: () => Promise<void>;
  onReplayOnboarding: () => void;
}

const PERM_ROWS: Array<{ key: PermissionKey; label: string; hint: string }> = [
  { key: "bluetooth", label: "Bluetooth (BLE)", hint: "Pindai & teruskan sinyal SOS offline" },
  { key: "location", label: "Lokasi GPS", hint: "Koordinat offline & kompas target" },
  { key: "microphone", label: "Mikrofon", hint: "Terima sinyal ultrasonik 18,5-20 kHz" },
  { key: "notifications", label: "Notifikasi", hint: "Status layanan latar belakang" },
  { key: "battery", label: "Bebas Optimasi Baterai", hint: "Tetap aktif saat layar mati" },
];

export const SettingsScreen = React.memo(function SettingsScreen({
  permissions,
  requestingPermission,
  settings,
  accelMs2,
  lightLux,
  isPocketBag,
  runtimeLabel,
  senderHint,
  relayedCount,
  rejectedCount,
  selectedRecord,
  selectedHex,
  onRequestPermission,
  onUpdateSetting,
  onSimulateImpact,
  onTogglePocketSim,
  onInjectBle,
  onInjectUltrasonic,
  onRotateCompass,
  onClearHistory,
  onReplayOnboarding,
}: SettingsScreenProps) {
  const [showLab, setShowLab] = useState(false);

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Text style={styles.title}>Pengaturan &amp; Izin</Text>
        <Text style={styles.subtitle}>
          Kelola izin Android, kepekaan sensor darurat, dan diagnostik perangkat.
        </Text>
      </View>

      {/* Runtime Permissions Section */}
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Izin Perangkat</Text>
        <View style={styles.dividerList}>
          {PERM_ROWS.map((row) => {
            const granted = permissions[row.key];
            return (
              <View key={row.key} style={styles.permRow}>
                <View style={styles.permInfo}>
                  <Text style={styles.rowTitle}>{row.label}</Text>
                  <Text style={styles.rowHint}>{row.hint}</Text>
                </View>

                <Pressable
                  onPress={() => void onRequestPermission(row.key)}
                  disabled={granted || requestingPermission}
                  style={[styles.permChip, granted ? styles.permChipOk : null]}
                  accessibilityRole="button"
                >
                  {granted ? (
                    <View style={styles.okRow}>
                      <IconCheck color={COLORS.positive} size={14} />
                      <Text style={styles.okText}>Aktif</Text>
                    </View>
                  ) : (
                    <Text style={styles.reqText}>Atur Izin</Text>
                  )}
                </Pressable>
              </View>
            );
          })}
        </View>
      </View>

      {/* Sensor & Acoustic Tuning Section */}
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Sensor Otomatis &amp; Akustik</Text>
        <View style={styles.sensorMetrics}>
          <View style={styles.metricTile}>
            <Text style={styles.metricLabel}>Guncangan</Text>
            <Text style={styles.metricValue}>{accelMs2.toFixed(1)} m/s^2</Text>
            <Text style={styles.metricSub}>Batas {settings.impactThresholdMs2.toFixed(0)} m/s^2</Text>
          </View>
          <View style={styles.metricTile}>
            <Text style={styles.metricLabel}>Cahaya</Text>
            <Text style={styles.metricValue}>{Math.round(lightLux)} lux</Text>
            <Text style={styles.metricSub}>{isPocketBag ? "Di Saku / Tas" : "Ruang Terbuka"}</Text>
          </View>
        </View>

        <View style={styles.stepperList}>
          <View style={styles.stepperRow}>
            <Text style={styles.stepperLabel}>
              Ambang benturan ({settings.impactThresholdMs2.toFixed(0)} m/s^2)
            </Text>
            <View style={styles.stepperGroup}>
              <Pressable
                onPress={() =>
                  onUpdateSetting("impactThresholdMs2", Math.max(16, settings.impactThresholdMs2 - 2))
                }
                style={styles.stepBtn}
                accessibilityRole="button"
              >
                <Text style={styles.stepBtnText}>-</Text>
              </Pressable>
              <Pressable
                onPress={() =>
                  onUpdateSetting("impactThresholdMs2", Math.min(48, settings.impactThresholdMs2 + 2))
                }
                style={styles.stepBtn}
                accessibilityRole="button"
              >
                <Text style={styles.stepBtnText}>+</Text>
              </Pressable>
            </View>
          </View>

          <View style={styles.stepperRow}>
            <Text style={styles.stepperLabel}>
              Ambang gelap saku ({settings.pocketLuxThreshold.toFixed(0)} lux)
            </Text>
            <View style={styles.stepperGroup}>
              <Pressable
                onPress={() =>
                  onUpdateSetting("pocketLuxThreshold", Math.max(1, settings.pocketLuxThreshold - 1))
                }
                style={styles.stepBtn}
                accessibilityRole="button"
              >
                <Text style={styles.stepBtnText}>-</Text>
              </Pressable>
              <Pressable
                onPress={() =>
                  onUpdateSetting("pocketLuxThreshold", Math.min(25, settings.pocketLuxThreshold + 1))
                }
                style={styles.stepBtn}
                accessibilityRole="button"
              >
                <Text style={styles.stepBtnText}>+</Text>
              </Pressable>
            </View>
          </View>

          <View style={styles.stepperRow}>
            <Text style={styles.stepperLabel}>
              Durasi simbol FSK ({settings.symbolDurationMs} ms)
            </Text>
            <View style={styles.stepperGroup}>
              <Pressable
                onPress={() =>
                  onUpdateSetting("symbolDurationMs", Math.max(10, settings.symbolDurationMs - 5))
                }
                style={styles.stepBtn}
                accessibilityRole="button"
              >
                <Text style={styles.stepBtnText}>-</Text>
              </Pressable>
              <Pressable
                onPress={() =>
                  onUpdateSetting("symbolDurationMs", Math.min(40, settings.symbolDurationMs + 5))
                }
                style={styles.stepBtn}
                accessibilityRole="button"
              >
                <Text style={styles.stepBtnText}>+</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </View>

      {/* Collapsible Field Lab & SMPv1 Diagnostics */}
      <View style={styles.card}>
        <Pressable
          onPress={() => setShowLab((v) => !v)}
          style={styles.collapseHeader}
          accessibilityRole="button"
        >
          <View>
            <Text style={styles.sectionTitle}>Mode Uji &amp; Diagnostik SMPv1</Text>
            <Text style={styles.rowHint}>
              Simulator sensor, injeksi sinyal uji, dan inspektor frame 56 byte.
            </Text>
          </View>
          <Text style={styles.collapseToggle}>{showLab ? "Sembunyikan" : "Buka"}</Text>
        </Pressable>

        {showLab ? (
          <View style={styles.labBody}>
            <View style={styles.simGrid}>
              <Pressable onPress={onSimulateImpact} style={styles.simBtn} accessibilityRole="button">
                <Text style={styles.simBtnText}>Tes Benturan</Text>
              </Pressable>
              <Pressable onPress={onTogglePocketSim} style={styles.simBtn} accessibilityRole="button">
                <Text style={styles.simBtnText}>
                  {isPocketBag ? "Ubah: Terbuka" : "Ubah: Di Saku"}
                </Text>
              </Pressable>
              <Pressable onPress={onInjectBle} style={styles.simBtn} accessibilityRole="button">
                <Text style={styles.simBtnText}>Simulasi Sinyal BLE</Text>
              </Pressable>
              <Pressable onPress={onInjectUltrasonic} style={styles.simBtn} accessibilityRole="button">
                <Text style={styles.simBtnText}>Simulasi 19 kHz</Text>
              </Pressable>
              <Pressable onPress={onRotateCompass} style={styles.simBtn} accessibilityRole="button">
                <Text style={styles.simBtnText}>Putar Kompas +35°</Text>
              </Pressable>
              <Pressable
                onPress={() => void onClearHistory()}
                style={[styles.simBtn, styles.simBtnDanger]}
                accessibilityRole="button"
              >
                <Text style={styles.simBtnDangerText}>Hapus Riwayat</Text>
              </Pressable>
            </View>

            <View style={styles.diagBox}>
              <Text style={styles.diagMeta}>
                Runtime: {runtimeLabel} · Node {senderHint.toUpperCase()} · Diteruskan: {relayedCount} · Ditolak: {rejectedCount}
              </Text>
              {selectedRecord ? (
                <Text style={styles.hexCode} selectable>
                  {selectedHex}
                </Text>
              ) : (
                <Text style={styles.diagMeta}>Belum ada frame biner terpilih.</Text>
              )}
            </View>
          </View>
        ) : null}
      </View>

      <Pressable
        onPress={onReplayOnboarding}
        style={styles.replayBtn}
        accessibilityRole="button"
      >
        <Text style={styles.replayBtnText}>Tampilkan Pengenalan Awal (Onboarding)</Text>
      </Pressable>
    </View>
  );
});

const styles = StyleSheet.create({
  root: {
    gap: 14,
  },
  header: {
    gap: 4,
  },
  title: {
    fontFamily: FONTS.sansMedium,
    fontSize: 20,
    fontWeight: "700",
    color: COLORS.text,
  },
  subtitle: {
    fontFamily: FONTS.sans,
    fontSize: 13,
    lineHeight: 19,
    color: COLORS.muted,
  },
  card: {
    backgroundColor: COLORS.surface,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: 14,
    padding: 16,
    gap: 12,
    ...CARD_SHADOW,
  },
  sectionTitle: {
    fontFamily: FONTS.sansMedium,
    fontSize: 15,
    fontWeight: "600",
    color: COLORS.text,
  },
  dividerList: {
    gap: 12,
  },
  permRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    paddingTop: 2,
  },
  permInfo: {
    flex: 1,
    gap: 2,
  },
  rowTitle: {
    fontFamily: FONTS.sansMedium,
    fontSize: 14,
    fontWeight: "600",
    color: COLORS.text,
  },
  rowHint: {
    fontFamily: FONTS.sans,
    fontSize: 12,
    color: COLORS.muted,
  },
  permChip: {
    minWidth: 82,
    height: 34,
    borderRadius: 8,
    backgroundColor: COLORS.sonarSoft,
    borderWidth: 1,
    borderColor: COLORS.sonarBorder,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 10,
  },
  permChipOk: {
    backgroundColor: COLORS.positiveSoft,
    borderColor: COLORS.positiveBorder,
  },
  okRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  okText: {
    fontFamily: FONTS.sansMedium,
    fontSize: 12,
    fontWeight: "600",
    color: COLORS.positive,
  },
  reqText: {
    fontFamily: FONTS.sansMedium,
    fontSize: 12,
    fontWeight: "600",
    color: COLORS.sonarDark,
  },
  sensorMetrics: {
    flexDirection: "row",
    gap: 10,
  },
  metricTile: {
    flex: 1,
    backgroundColor: COLORS.surfaceSubtle,
    borderColor: COLORS.rule,
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
  },
  metricLabel: {
    fontFamily: FONTS.sans,
    fontSize: 11,
    fontWeight: "600",
    color: COLORS.muted,
  },
  metricValue: {
    fontFamily: FONTS.sansMedium,
    fontSize: 18,
    fontWeight: "700",
    color: COLORS.text,
    marginTop: 4,
    fontVariant: ["tabular-nums"],
  },
  metricSub: {
    fontFamily: FONTS.sans,
    fontSize: 11,
    color: COLORS.muted,
    marginTop: 2,
  },
  stepperList: {
    gap: 10,
  },
  stepperRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  stepperLabel: {
    fontFamily: FONTS.sans,
    fontSize: 13,
    color: COLORS.textSecondary,
    fontVariant: ["tabular-nums"],
  },
  stepperGroup: {
    flexDirection: "row",
    gap: 8,
  },
  stepBtn: {
    width: 34,
    height: 32,
    borderRadius: 8,
    backgroundColor: COLORS.surfaceSubtle,
    borderWidth: 1,
    borderColor: COLORS.borderStrong,
    alignItems: "center",
    justifyContent: "center",
  },
  stepBtnText: {
    fontSize: 16,
    fontWeight: "700",
    color: COLORS.text,
  },
  collapseHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  collapseToggle: {
    fontFamily: FONTS.sansMedium,
    fontSize: 13,
    fontWeight: "600",
    color: COLORS.sonarDark,
  },
  labBody: {
    gap: 12,
    paddingTop: 6,
    borderTopWidth: 1,
    borderTopColor: COLORS.rule,
  },
  simGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  simBtn: {
    width: "48%",
    minHeight: 40,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: COLORS.borderStrong,
    backgroundColor: COLORS.surfaceSubtle,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 8,
  },
  simBtnText: {
    fontFamily: FONTS.sansMedium,
    fontSize: 12,
    fontWeight: "600",
    color: COLORS.text,
  },
  simBtnDanger: {
    backgroundColor: COLORS.sosSoft,
    borderColor: COLORS.sosBorder,
  },
  simBtnDangerText: {
    fontFamily: FONTS.sansMedium,
    fontSize: 12,
    fontWeight: "600",
    color: COLORS.sos,
  },
  diagBox: {
    backgroundColor: COLORS.surfaceSubtle,
    borderRadius: 8,
    padding: 10,
    gap: 6,
  },
  diagMeta: {
    fontFamily: FONTS.sans,
    fontSize: 11,
    color: COLORS.muted,
    fontVariant: ["tabular-nums"],
  },
  hexCode: {
    fontFamily: FONTS.mono,
    fontSize: 11,
    lineHeight: 17,
    color: COLORS.textSecondary,
  },
  replayBtn: {
    height: 44,
    borderRadius: 12,
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.borderStrong,
    alignItems: "center",
    justifyContent: "center",
  },
  replayBtnText: {
    fontFamily: FONTS.sansMedium,
    fontSize: 13,
    fontWeight: "600",
    color: COLORS.textSecondary,
  },
});
