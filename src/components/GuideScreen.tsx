import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { CARD_SHADOW, COLORS, FONTS } from "@/theme/tokens";

interface GuideScreenProps {
  onReplayOnboarding: () => void;
  onOpenSettings: () => void;
}

const GUIDE_SECTIONS = [
  {
    title: "1. Komunikasi Tanpa Internet (Mode Pesawat)",
    body: "SonarMesh menggabungkan Bluetooth Low Energy (BLE) dan gelombang suara near-ultrasonic (18,5-20 kHz). Setiap pesan SOS dikemas menjadi paket biner 56 byte (SMPv1) dengan verifikasi CRC-16 agar tahan gangguan.",
  },
  {
    title: "2. Mengirim Sinyal Darurat (SOS)",
    body: "Ketuk tombol bundar SOS di tab Darurat atau pilih pesan cepat (TERJEBAK, LUKA, BUTUH AIR, LT 2). Ponsel otomatis melampirkan koordinat GPS terakhir, level baterai, dan status lingkungan (Terbuka atau Di Saku/Tas).",
  },
  {
    title: "3. Deteksi Benturan & Mode Saku",
    body: "Sensor Accelerometer memantau guncangan keras dan memicu hitung mundur 10 detik yang dapat dibatalkan. Sensor Cahaya mendeteksi ponsel di dalam saku/tas; saat penolong mendekat, sirene 3,5 kHz dapat berbunyi otomatis.",
  },
  {
    title: "4. Mencari Korban dengan Radar & Spektrum",
    body: "Buka tab Radar untuk melihat arah kompas relatif dan estimasi jarak korban. Aktifkan 'Dengar Sinyal Suara' dan jalankan 'Kalibrasi 3 Detik' di ruangan tenang agar penangkapan sinyal 18,5-20 kHz lebih akurat.",
  },
  {
    title: "5. Estafet Multi-Hop Anti Banjir Sinyal",
    body: "Saat ponsel lain menerima paket valid dengan TTL > 1, perangkat menunggu jeda acak (200-2000 ms), menurunkan TTL - 1, lalu meneruskannya sekali saja berkat cache deduplikasi PACKET_ID.",
  },
];

export const GuideScreen = React.memo(function GuideScreen({
  onReplayOnboarding,
  onOpenSettings,
}: GuideScreenProps) {
  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Text style={styles.title}>Panduan Penggunaan</Text>
        <Text style={styles.subtitle}>
          Pahami cara kerja SonarMesh sebelum berada di situasi tanpa jaringan.
        </Text>
      </View>

      <View style={styles.list}>
        {GUIDE_SECTIONS.map((sec) => (
          <View key={sec.title} style={styles.card}>
            <Text style={styles.cardTitle}>{sec.title}</Text>
            <Text style={styles.cardBody}>{sec.body}</Text>
          </View>
        ))}
      </View>

      <View style={styles.actions}>
        <Pressable
          onPress={onReplayOnboarding}
          style={styles.primaryBtn}
          accessibilityRole="button"
        >
          <Text style={styles.primaryBtnText}>Buka Ulang Pengenalan Awal</Text>
        </Pressable>

        <Pressable
          onPress={onOpenSettings}
          style={styles.secondaryBtn}
          accessibilityRole="button"
        >
          <Text style={styles.secondaryBtnText}>Periksa Izin &amp; Pengaturan</Text>
        </Pressable>
      </View>
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
  list: {
    gap: 10,
  },
  card: {
    backgroundColor: COLORS.surface,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: 14,
    padding: 16,
    gap: 6,
    ...CARD_SHADOW,
  },
  cardTitle: {
    fontFamily: FONTS.sansMedium,
    fontSize: 15,
    fontWeight: "600",
    color: COLORS.text,
  },
  cardBody: {
    fontFamily: FONTS.sans,
    fontSize: 13,
    lineHeight: 20,
    color: COLORS.textSecondary,
  },
  actions: {
    gap: 8,
    marginTop: 4,
  },
  primaryBtn: {
    height: 46,
    borderRadius: 12,
    backgroundColor: COLORS.sonar,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryBtnText: {
    fontFamily: FONTS.sansMedium,
    fontSize: 14,
    fontWeight: "600",
    color: COLORS.white,
  },
  secondaryBtn: {
    height: 44,
    borderRadius: 12,
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.borderStrong,
    alignItems: "center",
    justifyContent: "center",
  },
  secondaryBtnText: {
    fontFamily: FONTS.sansMedium,
    fontSize: 14,
    fontWeight: "600",
    color: COLORS.text,
  },
});
