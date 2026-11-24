import React, { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { PermissionKey, PermissionSnapshot } from "@/permissions/androidPermissions";
import { IconCheck, IconShield, IconSonarMark } from "@/components/Icons";
import { CARD_SHADOW, COLORS, FONTS } from "@/theme/tokens";

interface OnboardingFlowProps {
  permissions: PermissionSnapshot;
  requestingPermission: boolean;
  onRequestPermission: (key: PermissionKey) => Promise<void>;
  onRequestAllAndFinish: () => Promise<void>;
  onComplete: () => Promise<void>;
}

const PERMISSION_ITEMS: Array<{
  key: PermissionKey;
  title: string;
  desc: string;
  requiredLabel: string;
}> = [
  {
    key: "bluetooth",
    title: "Bluetooth (BLE Mesh)",
    desc: "Mendeteksi dan meneruskan sinyal SOS ke ponsel terdekat tanpa internet.",
    requiredLabel: "Wajib",
  },
  {
    key: "location",
    title: "Lokasi GPS Offline",
    desc: "Menyematkan koordinat GPS terakhir dan arah kompas pada paket darurat.",
    requiredLabel: "Wajib",
  },
  {
    key: "microphone",
    title: "Mikrofon (Sinyal 19 kHz)",
    desc: "Aktif hanya saat Anda membuka Radar untuk mendengar sinyal ultrasonik.",
    requiredLabel: "Disarankan",
  },
  {
    key: "notifications",
    title: "Notifikasi Status",
    desc: "Menampilkan indikator layanan aktif dan peringatan saat SOS masuk.",
    requiredLabel: "Disarankan",
  },
  {
    key: "battery",
    title: "Bebas Optimasi Baterai",
    desc: "Menjaga relay Bluetooth tetap siaga saat layar ponsel mati.",
    requiredLabel: "Opsional",
  },
];

export function OnboardingFlow({
  permissions,
  requestingPermission,
  onRequestPermission,
  onRequestAllAndFinish,
  onComplete,
}: OnboardingFlowProps) {
  const [step, setStep] = useState<0 | 1 | 2>(0);

  return (
    <View style={styles.root}>
      {/* Top progress bar */}
      <View style={styles.topRow}>
        <View style={styles.brandRow}>
          <IconSonarMark color={COLORS.sonar} size={22} />
          <Text style={styles.brandText}>SonarMesh</Text>
        </View>
        <Text style={styles.stepLabel}>Langkah {step + 1} dari 3</Text>
      </View>

      <View style={styles.progressTrack}>
        <View style={[styles.progressFill, { width: `${((step + 1) / 3) * 100}%` }]} />
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        {step === 0 ? (
          <View style={styles.stepBlock}>
            <View style={styles.heroIconWrap}>
              <IconSonarMark color={COLORS.sonar} size={44} />
            </View>
            <Text style={styles.heading}>Tetap terhubung saat sinyal hilang total</Text>
            <Text style={styles.lead}>
              SonarMesh membantu Anda mengirim SOS dan menemukan korban di sekitar tanpa internet, kartu SIM, atau alat tambahan.
            </Text>

            <View style={styles.featureList}>
              <View style={styles.featureCard}>
                <Text style={styles.featureTitle}>100% Tanpa Internet</Text>
                <Text style={styles.featureDesc}>
                  Tetap berjalan di Mode Pesawat menggunakan Bluetooth hemat daya dan gelombang suara near-ultrasonic.
                </Text>
              </View>

              <View style={styles.featureCard}>
                <Text style={styles.featureTitle}>Radar Arah &amp; Koordinat Offline</Text>
                <Text style={styles.featureDesc}>
                  Lacak arah dan perkiraan jarak sinyal SOS langsung di radar kompas tanpa mengunduh peta online.
                </Text>
              </View>

              <View style={styles.featureCard}>
                <Text style={styles.featureTitle}>Deteksi Benturan &amp; Mode Saku</Text>
                <Text style={styles.featureDesc}>
                  Mendeteksi jatuh keras otomatis dengan hitung mundur batal, serta menyalakan sirene 3,5 kHz saat penolong mendekat.
                </Text>
              </View>
            </View>
          </View>
        ) : null}

        {step === 1 ? (
          <View style={styles.stepBlock}>
            <Text style={styles.eyebrow}>Cara Kerja Singkat</Text>
            <Text style={styles.heading}>Tiga langkah dalam situasi darurat</Text>
            <Text style={styles.lead}>
              Dirancang agar tetap mudah digunakan meski panik atau pencahayaan minim.
            </Text>

            <View style={styles.timeline}>
              <View style={styles.timelineItem}>
                <View style={styles.stepCircle}>
                  <Text style={styles.stepNum}>1</Text>
                </View>
                <View style={styles.timelineText}>
                  <Text style={styles.featureTitle}>Ketuk SOS atau Biarkan Sensor Bekerja</Text>
                  <Text style={styles.featureDesc}>
                    Ponsel mengemas lokasi GPS, baterai, dan pesan singkat ke paket 56 byte yang efisien lalu menyiarkannya lewat Bluetooth dan suara 19 kHz.
                  </Text>
                </View>
              </View>

              <View style={styles.timelineItem}>
                <View style={styles.stepCircle}>
                  <Text style={styles.stepNum}>2</Text>
                </View>
                <View style={styles.timelineText}>
                  <Text style={styles.featureTitle}>Estafet Otomatis Antar Ponsel</Text>
                  <Text style={styles.featureDesc}>
                    Ponsel sekitar yang memasang SonarMesh otomatis meneruskan paket valid (dengan batas hop TTL) agar jangkauan makin luas tanpa spam.
                  </Text>
                </View>
              </View>

              <View style={styles.timelineItem}>
                <View style={styles.stepCircle}>
                  <Text style={styles.stepNum}>3</Text>
                </View>
                <View style={styles.timelineText}>
                  <Text style={styles.featureTitle}>Lacak Lewat Radar &amp; Sirene 3,5 kHz</Text>
                  <Text style={styles.featureDesc}>
                    Penolong melihat arah kompas, spektrum suara 18,5-20 kHz, dan memicu sirene keras agar posisi fisik korban segera ditemukan.
                  </Text>
                </View>
              </View>
            </View>
          </View>
        ) : null}

        {step === 2 ? (
          <View style={styles.stepBlock}>
            <View style={styles.shieldRow}>
              <IconShield color={COLORS.sonar} size={20} />
              <Text style={styles.eyebrow}>Persiapan Izin Perangkat</Text>
            </View>
            <Text style={styles.heading}>Aktifkan izin agar fitur berjalan lancar</Text>
            <Text style={styles.lead}>
              Semua data diproses secara lokal di ponsel Anda. Anda tetap bisa melewati langkah ini dan mengaturnya nanti di Pengaturan.
            </Text>

            <View style={styles.permList}>
              {PERMISSION_ITEMS.map((item) => {
                const granted = permissions[item.key];
                return (
                  <View key={item.key} style={styles.permCard}>
                    <View style={styles.permInfo}>
                      <View style={styles.permTitleRow}>
                        <Text style={styles.permTitle}>{item.title}</Text>
                        <View
                          style={[
                            styles.reqBadge,
                            granted ? styles.reqBadgeGranted : styles.reqBadgePending,
                          ]}
                        >
                          <Text
                            style={[
                              styles.reqBadgeText,
                              granted ? styles.reqTextGranted : styles.reqTextPending,
                            ]}
                          >
                            {granted ? "Aktif" : item.requiredLabel}
                          </Text>
                        </View>
                      </View>
                      <Text style={styles.permDesc}>{item.desc}</Text>
                    </View>

                    <Pressable
                      onPress={() => void onRequestPermission(item.key)}
                      disabled={granted || requestingPermission}
                      style={[
                        styles.permBtn,
                        granted ? styles.permBtnGranted : null,
                      ]}
                      accessibilityRole="button"
                    >
                      {granted ? (
                        <IconCheck color={COLORS.positive} size={16} />
                      ) : (
                        <Text style={styles.permBtnText}>Izinkan</Text>
                      )}
                    </Pressable>
                  </View>
                );
              })}
            </View>
          </View>
        ) : null}
      </ScrollView>

      {/* Bottom Sticky Action Bar */}
      <View style={styles.footer}>
        {step < 2 ? (
          <View style={styles.footerRow}>
            {step > 0 ? (
              <Pressable
                onPress={() => setStep((s) => (s > 0 ? ((s - 1) as 0 | 1 | 2) : 0))}
                style={styles.secondaryBtn}
                accessibilityRole="button"
              >
                <Text style={styles.secondaryBtnText}>Kembali</Text>
              </Pressable>
            ) : (
              <Pressable
                onPress={() => void onComplete()}
                style={styles.ghostBtn}
                accessibilityRole="button"
              >
                <Text style={styles.ghostBtnText}>Lewati</Text>
              </Pressable>
            )}

            <Pressable
              onPress={() => setStep((s) => (s < 2 ? ((s + 1) as 0 | 1 | 2) : 2))}
              style={styles.primaryBtn}
              accessibilityRole="button"
            >
              <Text style={styles.primaryBtnText}>Lanjut</Text>
            </Pressable>
          </View>
        ) : (
          <View style={styles.footerStack}>
            <Pressable
              onPress={() => void onRequestAllAndFinish()}
              disabled={requestingPermission}
              style={styles.primaryBtnFull}
              accessibilityRole="button"
            >
              <Text style={styles.primaryBtnText}>
                {requestingPermission ? "Meminta izin..." : "Izinkan Semua & Mulai"}
              </Text>
            </Pressable>

            <View style={styles.footerSubRow}>
              <Pressable
                onPress={() => setStep(1)}
                style={styles.ghostBtn}
                accessibilityRole="button"
              >
                <Text style={styles.ghostBtnText}>Kembali</Text>
              </Pressable>
              <Pressable
                onPress={() => void onComplete()}
                style={styles.ghostBtn}
                accessibilityRole="button"
              >
                <Text style={styles.ghostBtnText}>Lewati, Atur Nanti</Text>
              </Pressable>
            </View>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: COLORS.ground,
  },
  topRow: {
    paddingHorizontal: 20,
    paddingTop: 14,
    paddingBottom: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  brandRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  brandText: {
    fontFamily: FONTS.sansMedium,
    fontSize: 16,
    fontWeight: "700",
    color: COLORS.text,
  },
  stepLabel: {
    fontFamily: FONTS.sans,
    fontSize: 12,
    fontWeight: "600",
    color: COLORS.muted,
  },
  progressTrack: {
    height: 3,
    backgroundColor: COLORS.border,
    marginHorizontal: 20,
    borderRadius: 2,
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    backgroundColor: COLORS.sonar,
  },
  scroll: {
    flex: 1,
  },
  content: {
    padding: 20,
    paddingBottom: 32,
    maxWidth: 540,
    width: "100%",
    alignSelf: "center",
  },
  stepBlock: {
    gap: 14,
  },
  heroIconWrap: {
    width: 68,
    height: 68,
    borderRadius: 18,
    backgroundColor: COLORS.sonarSoft,
    borderWidth: 1,
    borderColor: COLORS.sonarBorder,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 4,
  },
  shieldRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  eyebrow: {
    fontFamily: FONTS.sansMedium,
    fontSize: 12,
    fontWeight: "600",
    color: COLORS.sonarDark,
  },
  heading: {
    fontFamily: FONTS.sansMedium,
    fontSize: 24,
    fontWeight: "700",
    lineHeight: 31,
    letterSpacing: -0.4,
    color: COLORS.text,
  },
  lead: {
    fontFamily: FONTS.sans,
    fontSize: 14,
    lineHeight: 21,
    color: COLORS.muted,
  },
  featureList: {
    gap: 10,
    marginTop: 6,
  },
  featureCard: {
    backgroundColor: COLORS.surface,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: 14,
    padding: 16,
    gap: 4,
    ...CARD_SHADOW,
  },
  featureTitle: {
    fontFamily: FONTS.sansMedium,
    fontSize: 15,
    fontWeight: "600",
    color: COLORS.text,
  },
  featureDesc: {
    fontFamily: FONTS.sans,
    fontSize: 13,
    lineHeight: 19,
    color: COLORS.muted,
  },
  timeline: {
    gap: 14,
    marginTop: 6,
  },
  timelineItem: {
    flexDirection: "row",
    gap: 12,
    backgroundColor: COLORS.surface,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: 14,
    padding: 15,
    ...CARD_SHADOW,
  },
  stepCircle: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: COLORS.sonarSoft,
    borderWidth: 1,
    borderColor: COLORS.sonarBorder,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 2,
  },
  stepNum: {
    fontFamily: FONTS.sansMedium,
    fontSize: 13,
    fontWeight: "700",
    color: COLORS.sonarDark,
  },
  timelineText: {
    flex: 1,
    gap: 4,
  },
  permList: {
    gap: 10,
    marginTop: 4,
  },
  permCard: {
    backgroundColor: COLORS.surface,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: 14,
    padding: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    ...CARD_SHADOW,
  },
  permInfo: {
    flex: 1,
    gap: 4,
  },
  permTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 6,
  },
  permTitle: {
    fontFamily: FONTS.sansMedium,
    fontSize: 14,
    fontWeight: "600",
    color: COLORS.text,
  },
  reqBadge: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 6,
  },
  reqBadgeGranted: {
    backgroundColor: COLORS.positiveSoft,
  },
  reqBadgePending: {
    backgroundColor: COLORS.surfaceSubtle,
  },
  reqBadgeText: {
    fontSize: 11,
    fontWeight: "600",
  },
  reqTextGranted: { color: COLORS.positive },
  reqTextPending: { color: COLORS.muted },
  permDesc: {
    fontFamily: FONTS.sans,
    fontSize: 12,
    lineHeight: 17,
    color: COLORS.muted,
  },
  permBtn: {
    minWidth: 74,
    height: 36,
    borderRadius: 8,
    backgroundColor: COLORS.sonarSoft,
    borderWidth: 1,
    borderColor: COLORS.sonarBorder,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 10,
  },
  permBtnGranted: {
    backgroundColor: COLORS.positiveSoft,
    borderColor: COLORS.positiveBorder,
  },
  permBtnText: {
    fontFamily: FONTS.sansMedium,
    fontSize: 12,
    fontWeight: "600",
    color: COLORS.sonarDark,
  },
  footer: {
    backgroundColor: COLORS.surface,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
    paddingHorizontal: 20,
    paddingVertical: 14,
  },
  footerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    maxWidth: 540,
    width: "100%",
    alignSelf: "center",
  },
  footerStack: {
    gap: 8,
    maxWidth: 540,
    width: "100%",
    alignSelf: "center",
  },
  footerSubRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  primaryBtn: {
    flex: 1,
    height: 48,
    borderRadius: 12,
    backgroundColor: COLORS.sonar,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryBtnFull: {
    height: 48,
    borderRadius: 12,
    backgroundColor: COLORS.sonar,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryBtnText: {
    fontFamily: FONTS.sansMedium,
    fontSize: 15,
    fontWeight: "600",
    color: COLORS.white,
  },
  secondaryBtn: {
    height: 48,
    paddingHorizontal: 18,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.borderStrong,
    backgroundColor: COLORS.surface,
    alignItems: "center",
    justifyContent: "center",
  },
  secondaryBtnText: {
    fontFamily: FONTS.sansMedium,
    fontSize: 14,
    fontWeight: "600",
    color: COLORS.text,
  },
  ghostBtn: {
    paddingVertical: 8,
    paddingHorizontal: 10,
  },
  ghostBtnText: {
    fontFamily: FONTS.sansMedium,
    fontSize: 13,
    fontWeight: "600",
    color: COLORS.muted,
  },
});
