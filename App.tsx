import React, { useCallback, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { DEFAULT_SONARMESH_SETTINGS } from "@/config/sonarmeshConfig";
import type { StoredSosRecord } from "@/storage/packetStore";
import { sonarMeshBridge } from "@/native/sonarMeshBridge";
import { useSonarMeshApp } from "@/state/useSonarMeshApp";
import { AppErrorBoundary } from "@/components/ErrorBoundary";
import { OnboardingFlow } from "@/components/OnboardingFlow";
import { CompassRadar } from "@/components/CompassRadar";
import { SpectrumAnalyzer } from "@/components/SpectrumAnalyzer";
import { OfflineCoordinatePlot } from "@/components/OfflineCoordinatePlot";
import { SosPacketRow } from "@/components/SosPacketRow";
import { GuideScreen } from "@/components/GuideScreen";
import { SettingsScreen } from "@/components/SettingsScreen";
import {
  IconGuide,
  IconRadar,
  IconSettings,
  IconSiren,
  IconSonarMark,
  IconSosBeacon,
  IconWave,
} from "@/components/Icons";
import { CARD_SHADOW, COLORS, FONTS } from "@/theme/tokens";

type MainTab = "sos" | "radar" | "guide" | "settings";
type RadarSubView = "list" | "coords";

const QUICK_NOTES = ["TERJEBAK", "LUKA", "BUTUH AIR", "LT 2"] as const;

function SonarMeshRoot() {
  const app = useSonarMeshApp();
  const [mainTab, setMainTab] = useState<MainTab>("sos");
  const [radarSubView, setRadarSubView] = useState<RadarSubView>("list");

  const renderPacketItem = useCallback(
    ({ item }: { item: StoredSosRecord }) => (
      <SosPacketRow
        record={item}
        selected={item.packetId === app.selectedRecord?.packetId}
        myLat={app.deviceState?.lastLatitude ?? -7.257472}
        myLon={app.deviceState?.lastLongitude ?? 112.752088}
        onSelect={app.setSelectedPacketId}
      />
    ),
    [
      app.deviceState?.lastLatitude,
      app.deviceState?.lastLongitude,
      app.selectedRecord?.packetId,
      app.setSelectedPacketId,
    ]
  );

  const keyExtractor = useCallback((item: StoredSosRecord) => item.packetId, []);

  if (app.booting) {
    return (
      <SafeAreaView style={styles.bootRoot}>
        <StatusBar style="dark" />
        <IconSonarMark color={COLORS.sonar} size={40} />
        <Text style={styles.bootTitle}>SonarMesh</Text>
        <ActivityIndicator color={COLORS.sonar} style={styles.bootSpinner} />
      </SafeAreaView>
    );
  }

  if (app.showOnboarding) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <StatusBar style="dark" />
        <OnboardingFlow
          permissions={app.permissions}
          requestingPermission={app.requestingPerm}
          onRequestPermission={app.handleRequestSinglePermission}
          onRequestAllAndFinish={app.handleRequestAllAndFinish}
          onComplete={app.handleSkipOnboarding}
        />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="dark" />

      {/* Clean Minimalist Light App Bar */}
      <View style={styles.headerBar}>
        <View style={styles.brandGroup}>
          <IconSonarMark color={COLORS.sonar} size={22} />
          <Text style={styles.brandTitle}>SonarMesh</Text>
          <View style={[styles.statusPill, app.meshRunning ? styles.pillGreen : styles.pillMuted]}>
            <View
              style={[
                styles.dot,
                { backgroundColor: app.meshRunning ? COLORS.positiveDot : COLORS.muted },
              ]}
            />
            <Text
              style={[
                styles.statusPillText,
                { color: app.meshRunning ? COLORS.positive : COLORS.muted },
              ]}
            >
              {app.meshRunning ? "Offline Siap" : "Siaga"}
            </Text>
          </View>
        </View>

        <View style={styles.headerRight}>
          {app.isPocketBag ? (
            <View style={styles.pocketBadge}>
              <Text style={styles.pocketBadgeText}>Di Saku</Text>
            </View>
          ) : null}
          <Text style={styles.battText}>{app.batteryPct}%</Text>
        </View>
      </View>

      {/* Global Urgent Banners */}
      {app.countdownSec !== null ? (
        <View style={styles.urgentBanner}>
          <View style={styles.urgentTextCol}>
            <Text style={styles.urgentTitle}>
              Benturan terdeteksi · SOS dalam {app.countdownSec} detik
            </Text>
            <Text style={styles.urgentSub}>Ketuk batalkan jika ponsel hanya terjatuh biasa.</Text>
          </View>
          <Pressable
            onPress={app.cancelSosCountdown}
            style={styles.cancelUrgentBtn}
            accessibilityRole="button"
          >
            <Text style={styles.cancelUrgentText}>Batalkan</Text>
          </Pressable>
        </View>
      ) : null}

      {app.sirenActive ? (
        <View style={styles.sirenBanner}>
          <Text style={styles.sirenBannerText}>Sirene Darurat 3,5 kHz Menyala</Text>
          <Pressable
            onPress={() => void app.toggleSiren()}
            style={styles.stopSirenChip}
            accessibilityRole="button"
          >
            <Text style={styles.stopSirenChipText}>Matikan</Text>
          </Pressable>
        </View>
      ) : null}

      {app.toastMsg ? (
        <View style={styles.toastRow}>
          <Text style={styles.toastText}>{app.toastMsg}</Text>
          <Pressable onPress={() => app.setToastMsg(null)} accessibilityRole="button">
            <Text style={styles.toastClose}>Tutup</Text>
          </Pressable>
        </View>
      ) : null}

      {/* Main Content */}
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {/* Missing permission calm inline callout */}
        {app.missingPerms.length > 0 && mainTab !== "settings" ? (
          <View style={styles.permAlertCard}>
            <View style={styles.permAlertTextCol}>
              <Text style={styles.permAlertTitle}>Beberapa izin belum aktif</Text>
              <Text style={styles.permAlertSub}>
                Belum diizinkan: {app.missingPerms.join(", ")}. Aktifkan agar BLE &amp; Radar bekerja penuh.
              </Text>
            </View>
            <Pressable
              onPress={() => setMainTab("settings")}
              style={styles.permAlertBtn}
              accessibilityRole="button"
            >
              <Text style={styles.permAlertBtnText}>Atur Izin</Text>
            </Pressable>
          </View>
        ) : null}

        {/* TAB 1: DARURAT (SOS HOME) */}
        {mainTab === "sos" ? (
          <View style={styles.sosScreen}>
            <View style={styles.heroIntro}>
              <Text style={styles.heroHeading}>
                {app.sosActive ? "Sinyal SOS Sedang Dipancarkan" : "Bantuan Darurat Tanpa Internet"}
              </Text>
              <Text style={styles.heroSub}>
                {app.sosActive
                  ? "Lokasi GPS dan pesan singkat sedang disiarkan lewat Bluetooth dan suara 19 kHz."
                  : "Tetap aktif di Mode Pesawat menggunakan Bluetooth dan gelombang suara."}
              </Text>
            </View>

            {/* Centerpiece Circular SOS Trigger */}
            <View style={styles.sosCenterWrap}>
              <View style={[styles.sosOuterRing, app.sosActive ? styles.sosOuterRingActive : null]}>
                <Pressable
                  onPress={() => void app.toggleSos()}
                  style={[styles.sosCircleBtn, app.sosActive ? styles.sosCircleBtnActive : null]}
                  accessibilityRole="button"
                  accessibilityLabel={
                    app.sosActive ? "Hentikan siaran SOS" : "Kirim sinyal SOS darurat"
                  }
                >
                  <Text
                    style={[
                      styles.sosCircleTitle,
                      app.sosActive ? styles.sosCircleTitleActive : null,
                    ]}
                  >
                    {app.sosActive ? "HENTIKAN" : "SOS"}
                  </Text>
                  <Text
                    style={[
                      styles.sosCircleSub,
                      app.sosActive ? styles.sosCircleSubActive : null,
                    ]}
                  >
                    {app.sosActive ? "SOS sedang aktif" : "Ketuk untuk kirim"}
                  </Text>
                </Pressable>
              </View>
            </View>

            {/* Quick Emergency Message Selector */}
            <View style={styles.noteCard}>
              <Text style={styles.cardLabel}>Pesan singkat yang ikut dikirim (maks 9 huruf)</Text>
              <View style={styles.presetRow}>
                {QUICK_NOTES.map((preset) => {
                  const active = app.shortNote.trim().toUpperCase() === preset;
                  return (
                    <Pressable
                      key={preset}
                      onPress={() => app.setShortNote(preset)}
                      style={[styles.presetChip, active ? styles.presetChipActive : null]}
                      accessibilityRole="button"
                    >
                      <Text style={[styles.presetText, active ? styles.presetTextActive : null]}>
                        {preset}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
              <TextInput
                value={app.shortNote}
                onChangeText={app.setShortNote}
                maxLength={9}
                placeholder="Ketik pesan pendek..."
                placeholderTextColor={COLORS.muted}
                style={styles.noteInput}
              />
            </View>

            {/* Secondary Rescue Controls */}
            <View style={styles.dualActionRow}>
              <Pressable
                onPress={() => void app.toggleSiren()}
                style={[styles.bigToolBtn, app.sirenActive ? styles.bigToolBtnWarn : null]}
                accessibilityRole="button"
              >
                <IconSiren color={app.sirenActive ? COLORS.amber : COLORS.text} size={20} />
                <Text style={[styles.bigToolTitle, app.sirenActive ? styles.textAmber : null]}>
                  {app.sirenActive ? "Matikan Sirene" : "Sirene 3,5 kHz"}
                </Text>
                <Text style={styles.bigToolSub}>Panggil penolong sekitar</Text>
              </Pressable>

              <Pressable
                onPress={() => void app.sendUltrasonicPing()}
                style={styles.bigToolBtn}
                accessibilityRole="button"
              >
                <IconWave color={COLORS.sonar} size={20} />
                <Text style={styles.bigToolTitle}>Kirim Ping Suara</Text>
                <Text style={styles.bigToolSub}>Gelombang 18,5-20 kHz</Text>
              </Pressable>
            </View>

            {/* Jump Card to Radar */}
            <Pressable
              onPress={() => setMainTab("radar")}
              style={styles.summaryCard}
              accessibilityRole="button"
            >
              <View style={styles.summaryLeft}>
                <Text style={styles.summaryTitle}>
                  {app.records.length > 0
                    ? `${app.records.length} sinyal SOS tersimpan di sekitar`
                    : "Buka Radar Pencari Korban"}
                </Text>
                <Text style={styles.summarySub}>
                  GPS terakhir: {(app.deviceState?.lastLatitude ?? -7.257472).toFixed(4)},{" "}
                  {(app.deviceState?.lastLongitude ?? 112.752088).toFixed(4)}
                </Text>
              </View>
              <Text style={styles.summaryAction}>Lihat Radar</Text>
            </Pressable>
          </View>
        ) : null}

        {/* TAB 2: RADAR + SPECTRUM + OFFLINE COORDS */}
        {mainTab === "radar" ? (
          <View style={styles.sectionStack}>
            <CompassRadar
              headingDeg={app.headingDeg}
              myLat={app.deviceState?.lastLatitude ?? -7.257472}
              myLon={app.deviceState?.lastLongitude ?? 112.752088}
              records={app.records}
              selectedPacketId={app.selectedRecord?.packetId ?? null}
              onSelectPacket={app.setSelectedPacketId}
            />

            <SpectrumAnalyzer
              frame={app.spectrum}
              listening={app.acousticListening}
              calibrating={app.calibrating}
              micPermissionGranted={app.permissions.microphone}
              freqSpace0Hz={app.deviceState?.settings.freqSpace0Hz ?? 18750}
              freqMark1Hz={app.deviceState?.settings.freqMark1Hz ?? 19500}
              thresholdDb={app.thresholdDb}
              onToggleListen={() => void app.toggleAcousticListen()}
              onCalibrate={() => void app.calibrateNoiseFloor()}
            />

            <View style={styles.segmentedBar}>
              <Pressable
                onPress={() => setRadarSubView("list")}
                style={[styles.segBtn, radarSubView === "list" ? styles.segBtnActive : null]}
                accessibilityRole="tab"
              >
                <Text style={[styles.segText, radarSubView === "list" ? styles.segTextActive : null]}>
                  Daftar Sinyal ({app.records.length})
                </Text>
              </Pressable>
              <Pressable
                onPress={() => setRadarSubView("coords")}
                style={[styles.segBtn, radarSubView === "coords" ? styles.segBtnActive : null]}
                accessibilityRole="tab"
              >
                <Text style={[styles.segText, radarSubView === "coords" ? styles.segTextActive : null]}>
                  Koordinat Offline
                </Text>
              </Pressable>
            </View>

            {radarSubView === "list" ? (
              app.records.length === 0 ? (
                <View style={styles.emptyCard}>
                  <Text style={styles.emptyTitle}>Belum ada sinyal masuk</Text>
                  <Text style={styles.emptySub}>
                    Aktifkan "Dengar Sinyal Suara" di atas atau buka Mode Uji di Pengaturan untuk melihat contoh sinyal SOS.
                  </Text>
                </View>
              ) : (
                <FlatList
                  data={app.records}
                  renderItem={renderPacketItem}
                  keyExtractor={keyExtractor}
                  scrollEnabled={false}
                />
              )
            ) : (
              <OfflineCoordinatePlot
                myLat={app.deviceState?.lastLatitude ?? -7.257472}
                myLon={app.deviceState?.lastLongitude ?? 112.752088}
                myAccuracyM={app.deviceState?.lastAccuracyM ?? 12}
                records={app.records}
              />
            )}
          </View>
        ) : null}

        {/* TAB 3: PANDUAN */}
        {mainTab === "guide" ? (
          <GuideScreen
            onReplayOnboarding={() => app.setShowOnboarding(true)}
            onOpenSettings={() => setMainTab("settings")}
          />
        ) : null}

        {/* TAB 4: PENGATURAN & LAB */}
        {mainTab === "settings" ? (
          <SettingsScreen
            permissions={app.permissions}
            requestingPermission={app.requestingPerm}
            settings={app.deviceState?.settings ?? DEFAULT_SONARMESH_SETTINGS}
            accelMs2={app.accelMs2}
            lightLux={app.lightLux}
            isPocketBag={app.isPocketBag}
            runtimeLabel={sonarMeshBridge.runtimeLabel}
            senderHint={app.deviceState?.senderHint ?? "--------"}
            relayedCount={app.relayedCount}
            rejectedCount={app.rejectedCount}
            selectedRecord={app.selectedRecord}
            selectedHex={app.selectedHex}
            onRequestPermission={app.handleRequestSinglePermission}
            onUpdateSetting={app.updateSetting}
            onSimulateImpact={() => sonarMeshBridge.simulateImpactShock(35.2)}
            onTogglePocketSim={() => sonarMeshBridge.simulatePocketToggle(!app.isPocketBag)}
            onInjectBle={() => {
              sonarMeshBridge.injectSimulatedInboundPacket(
                app.deviceState?.lastLatitude ?? -7.257472,
                app.deviceState?.lastLongitude ?? 112.752088,
                "ble"
              );
              setMainTab("radar");
            }}
            onInjectUltrasonic={() => {
              sonarMeshBridge.injectSimulatedInboundPacket(
                app.deviceState?.lastLatitude ?? -7.257472,
                app.deviceState?.lastLongitude ?? 112.752088,
                "ultrasonic"
              );
              setMainTab("radar");
            }}
            onRotateCompass={() => sonarMeshBridge.simulateCompassShift(35)}
            onClearHistory={app.clearHistory}
            onReplayOnboarding={() => app.setShowOnboarding(true)}
          />
        ) : null}
      </ScrollView>

      {/* Clean Minimalist 4-Tab Bottom Navigation Bar */}
      <View style={styles.bottomNav}>
        <Pressable
          onPress={() => setMainTab("sos")}
          style={styles.navItem}
          accessibilityRole="tab"
        >
          <IconSosBeacon
            color={mainTab === "sos" ? (app.sosActive ? COLORS.sosFill : COLORS.sonar) : COLORS.muted}
            size={21}
          />
          <Text style={[styles.navLabel, mainTab === "sos" ? styles.navLabelActive : null]}>
            Darurat
          </Text>
        </Pressable>

        <Pressable
          onPress={() => setMainTab("radar")}
          style={styles.navItem}
          accessibilityRole="tab"
        >
          <View style={styles.navIconWrap}>
            <IconRadar color={mainTab === "radar" ? COLORS.sonar : COLORS.muted} size={21} />
            {app.records.length > 0 ? (
              <View style={styles.navBadge}>
                <Text style={styles.navBadgeText}>
                  {app.records.length > 9 ? "9+" : app.records.length}
                </Text>
              </View>
            ) : null}
          </View>
          <Text style={[styles.navLabel, mainTab === "radar" ? styles.navLabelActive : null]}>
            Radar
          </Text>
        </Pressable>

        <Pressable
          onPress={() => setMainTab("guide")}
          style={styles.navItem}
          accessibilityRole="tab"
        >
          <IconGuide color={mainTab === "guide" ? COLORS.sonar : COLORS.muted} size={21} />
          <Text style={[styles.navLabel, mainTab === "guide" ? styles.navLabelActive : null]}>
            Panduan
          </Text>
        </Pressable>

        <Pressable
          onPress={() => setMainTab("settings")}
          style={styles.navItem}
          accessibilityRole="tab"
        >
          <View style={styles.navIconWrap}>
            <IconSettings color={mainTab === "settings" ? COLORS.sonar : COLORS.muted} size={21} />
            {app.missingPerms.length > 0 ? <View style={styles.warnDot} /> : null}
          </View>
          <Text style={[styles.navLabel, mainTab === "settings" ? styles.navLabelActive : null]}>
            Pengaturan
          </Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <AppErrorBoundary>
        <SonarMeshRoot />
      </AppErrorBoundary>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: COLORS.ground,
  },
  bootRoot: {
    flex: 1,
    backgroundColor: COLORS.ground,
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  bootTitle: {
    fontFamily: FONTS.sansMedium,
    fontSize: 20,
    fontWeight: "700",
    color: COLORS.text,
  },
  bootSpinner: {
    marginTop: 6,
  },
  headerBar: {
    height: 56,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: COLORS.surface,
  },
  brandGroup: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  brandTitle: {
    fontFamily: FONTS.sansMedium,
    color: COLORS.text,
    fontSize: 17,
    fontWeight: "700",
    letterSpacing: -0.3,
  },
  statusPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 20,
    borderWidth: 1,
  },
  pillGreen: {
    backgroundColor: COLORS.positiveSoft,
    borderColor: COLORS.positiveBorder,
  },
  pillMuted: {
    backgroundColor: COLORS.surfaceSubtle,
    borderColor: COLORS.border,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  statusPillText: {
    fontFamily: FONTS.sansMedium,
    fontSize: 11,
    fontWeight: "600",
  },
  headerRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  pocketBadge: {
    backgroundColor: COLORS.amberSoft,
    borderColor: COLORS.amberBorder,
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  pocketBadgeText: {
    fontFamily: FONTS.sansMedium,
    color: COLORS.amber,
    fontSize: 11,
    fontWeight: "600",
  },
  battText: {
    fontFamily: FONTS.sansMedium,
    color: COLORS.muted,
    fontSize: 12,
    fontWeight: "600",
    fontVariant: ["tabular-nums"],
  },
  urgentBanner: {
    backgroundColor: COLORS.sosSoft,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.sosBorder,
    paddingHorizontal: 16,
    paddingVertical: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  urgentTextCol: { flex: 1 },
  urgentTitle: {
    fontFamily: FONTS.sansMedium,
    color: COLORS.sos,
    fontSize: 14,
    fontWeight: "700",
  },
  urgentSub: {
    fontFamily: FONTS.sans,
    color: COLORS.textSecondary,
    fontSize: 12,
    marginTop: 2,
  },
  cancelUrgentBtn: {
    backgroundColor: COLORS.sosFill,
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 8,
  },
  cancelUrgentText: {
    fontFamily: FONTS.sansMedium,
    color: COLORS.white,
    fontSize: 12,
    fontWeight: "700",
  },
  sirenBanner: {
    backgroundColor: COLORS.amberSoft,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.amberBorder,
    paddingHorizontal: 16,
    paddingVertical: 9,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  sirenBannerText: {
    fontFamily: FONTS.sansMedium,
    color: COLORS.amber,
    fontSize: 13,
    fontWeight: "700",
  },
  stopSirenChip: {
    backgroundColor: COLORS.amberFill,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
  },
  stopSirenChipText: {
    fontFamily: FONTS.sansMedium,
    color: COLORS.white,
    fontSize: 12,
    fontWeight: "700",
  },
  toastRow: {
    backgroundColor: COLORS.surface,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
    paddingHorizontal: 16,
    paddingVertical: 9,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  toastText: {
    fontFamily: FONTS.sans,
    color: COLORS.textSecondary,
    fontSize: 12,
    flex: 1,
  },
  toastClose: {
    fontFamily: FONTS.sansMedium,
    color: COLORS.sonarDark,
    fontSize: 12,
    fontWeight: "600",
  },
  scroll: { flex: 1 },
  scrollContent: {
    padding: 16,
    paddingBottom: 28,
    maxWidth: 560,
    width: "100%",
    alignSelf: "center",
    gap: 14,
  },
  permAlertCard: {
    backgroundColor: COLORS.amberSoft,
    borderColor: COLORS.amberBorder,
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  permAlertTextCol: {
    flex: 1,
    gap: 2,
  },
  permAlertTitle: {
    fontFamily: FONTS.sansMedium,
    fontSize: 13,
    fontWeight: "700",
    color: COLORS.amber,
  },
  permAlertSub: {
    fontFamily: FONTS.sans,
    fontSize: 12,
    lineHeight: 17,
    color: COLORS.textSecondary,
  },
  permAlertBtn: {
    backgroundColor: COLORS.surface,
    borderColor: COLORS.amberBorder,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 11,
    paddingVertical: 7,
  },
  permAlertBtnText: {
    fontFamily: FONTS.sansMedium,
    fontSize: 12,
    fontWeight: "600",
    color: COLORS.amber,
  },
  sosScreen: { gap: 16 },
  heroIntro: {
    alignItems: "center",
    paddingHorizontal: 8,
    paddingTop: 4,
  },
  heroHeading: {
    fontFamily: FONTS.sansMedium,
    color: COLORS.text,
    fontSize: 20,
    fontWeight: "700",
    textAlign: "center",
    letterSpacing: -0.3,
  },
  heroSub: {
    fontFamily: FONTS.sans,
    color: COLORS.muted,
    fontSize: 13,
    lineHeight: 20,
    textAlign: "center",
    marginTop: 5,
  },
  sosCenterWrap: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 6,
  },
  sosOuterRing: {
    width: 196,
    height: 196,
    borderRadius: 98,
    backgroundColor: COLORS.sosRing,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1.5,
    borderColor: COLORS.sosBorder,
  },
  sosOuterRingActive: {
    backgroundColor: COLORS.sosSoft,
    borderWidth: 2,
    borderColor: COLORS.sosFill,
  },
  sosCircleBtn: {
    width: 164,
    height: 164,
    borderRadius: 82,
    backgroundColor: COLORS.sosFill,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 14,
    ...CARD_SHADOW,
  },
  sosCircleBtnActive: {
    backgroundColor: COLORS.surface,
    borderWidth: 2.5,
    borderColor: COLORS.sosFill,
  },
  sosCircleTitle: {
    fontFamily: FONTS.sansMedium,
    color: COLORS.white,
    fontSize: 30,
    fontWeight: "800",
    letterSpacing: 1,
  },
  sosCircleTitleActive: {
    color: COLORS.sosFill,
    fontSize: 22,
  },
  sosCircleSub: {
    fontFamily: FONTS.sans,
    color: "#FEE2E2",
    fontSize: 12,
    fontWeight: "600",
    marginTop: 4,
    textAlign: "center",
  },
  sosCircleSubActive: {
    color: COLORS.sos,
  },
  noteCard: {
    backgroundColor: COLORS.surface,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: 16,
    padding: 15,
    gap: 10,
    ...CARD_SHADOW,
  },
  cardLabel: {
    fontFamily: FONTS.sansMedium,
    color: COLORS.muted,
    fontSize: 12,
    fontWeight: "600",
  },
  presetRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  presetChip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 8,
    backgroundColor: COLORS.surfaceSubtle,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  presetChipActive: {
    backgroundColor: COLORS.sonarSoft,
    borderColor: COLORS.sonarBorder,
  },
  presetText: {
    fontFamily: FONTS.sansMedium,
    color: COLORS.textSecondary,
    fontSize: 12,
    fontWeight: "600",
  },
  presetTextActive: {
    color: COLORS.sonarDark,
  },
  noteInput: {
    height: 44,
    backgroundColor: COLORS.ground,
    borderColor: COLORS.borderStrong,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    fontFamily: FONTS.sansMedium,
    color: COLORS.text,
    fontSize: 14,
    fontWeight: "600",
  },
  dualActionRow: {
    flexDirection: "row",
    gap: 10,
  },
  bigToolBtn: {
    flex: 1,
    backgroundColor: COLORS.surface,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: 14,
    padding: 14,
    gap: 4,
    minHeight: 92,
    justifyContent: "center",
    ...CARD_SHADOW,
  },
  bigToolBtnWarn: {
    backgroundColor: COLORS.amberSoft,
    borderColor: COLORS.amberBorder,
  },
  bigToolTitle: {
    fontFamily: FONTS.sansMedium,
    color: COLORS.text,
    fontSize: 14,
    fontWeight: "700",
    marginTop: 4,
  },
  bigToolSub: {
    fontFamily: FONTS.sans,
    color: COLORS.muted,
    fontSize: 11,
  },
  textAmber: { color: COLORS.amber },
  summaryCard: {
    backgroundColor: COLORS.surface,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: 14,
    padding: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    ...CARD_SHADOW,
  },
  summaryLeft: {
    flex: 1,
    gap: 3,
  },
  summaryTitle: {
    fontFamily: FONTS.sansMedium,
    color: COLORS.text,
    fontSize: 14,
    fontWeight: "600",
  },
  summarySub: {
    fontFamily: FONTS.mono,
    color: COLORS.muted,
    fontSize: 11,
    fontVariant: ["tabular-nums"],
  },
  summaryAction: {
    fontFamily: FONTS.sansMedium,
    color: COLORS.sonarDark,
    fontSize: 13,
    fontWeight: "700",
  },
  sectionStack: { gap: 14 },
  segmentedBar: {
    flexDirection: "row",
    backgroundColor: COLORS.surfaceSubtle,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: 12,
    padding: 4,
    gap: 4,
  },
  segBtn: {
    flex: 1,
    paddingVertical: 9,
    borderRadius: 9,
    alignItems: "center",
  },
  segBtnActive: {
    backgroundColor: COLORS.surface,
    ...CARD_SHADOW,
  },
  segText: {
    fontFamily: FONTS.sansMedium,
    color: COLORS.muted,
    fontSize: 13,
    fontWeight: "600",
  },
  segTextActive: {
    color: COLORS.text,
  },
  emptyCard: {
    backgroundColor: COLORS.surface,
    borderColor: COLORS.borderStrong,
    borderWidth: 1,
    borderStyle: "dashed",
    borderRadius: 14,
    padding: 20,
    alignItems: "center",
  },
  emptyTitle: {
    fontFamily: FONTS.sansMedium,
    color: COLORS.text,
    fontSize: 14,
    fontWeight: "700",
  },
  emptySub: {
    fontFamily: FONTS.sans,
    color: COLORS.muted,
    fontSize: 12,
    lineHeight: 18,
    marginTop: 6,
    textAlign: "center",
  },
  bottomNav: {
    height: 62,
    backgroundColor: COLORS.surface,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-around",
  },
  navItem: {
    flex: 1,
    height: "100%",
    alignItems: "center",
    justifyContent: "center",
    gap: 3,
  },
  navIconWrap: { position: "relative" },
  navBadge: {
    position: "absolute",
    top: -4,
    right: -10,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: COLORS.sosFill,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 4,
  },
  navBadgeText: {
    color: COLORS.white,
    fontSize: 10,
    fontWeight: "700",
  },
  warnDot: {
    position: "absolute",
    top: -2,
    right: -4,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: COLORS.amberFill,
  },
  navLabel: {
    fontFamily: FONTS.sansMedium,
    color: COLORS.muted,
    fontSize: 11,
    fontWeight: "600",
  },
  navLabelActive: {
    color: COLORS.sonarDark,
    fontWeight: "700",
  },
});
