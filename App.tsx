import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
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
import type { NativeSpectrumFrame } from "sonarmesh-native";
import {
  DEFAULT_SONARMESH_SETTINGS,
  SONARMESH_CONSTANTS,
  type SonarMeshSettings,
} from "@/config/sonarmeshConfig";
import { accuracyMetersToBucket, batteryPctToQuant } from "@/protocol/geo";
import {
  PacketDeduplicator,
  base64ToBytes,
  bytesToHex,
  decodeSmpV1,
  encodeSmpV1,
  prepareRelayPacket,
  randomHex,
  type TriggerType,
} from "@/protocol/smpv1";
import {
  createRecordFromBytes,
  packetStore,
  type PersistedDeviceState,
  type StoredSosRecord,
} from "@/storage/packetStore";
import { sonarMeshBridge } from "@/native/sonarMeshBridge";
import { CompassRadar } from "@/components/CompassRadar";
import { SpectrumAnalyzer } from "@/components/SpectrumAnalyzer";
import { OfflineCoordinatePlot } from "@/components/OfflineCoordinatePlot";
import { SosPacketRow } from "@/components/SosPacketRow";
import {
  IconLab,
  IconRadar,
  IconSiren,
  IconSosBeacon,
  IconWave,
} from "@/components/Icons";
import { COLORS } from "@/theme/tokens";

type MainTab = "sos" | "radar" | "tools";
type RadarSubView = "list" | "coords";

const QUICK_NOTES = ["TERJEBAK", "LUKA", "BUTUH AIR", "LT 2"] as const;

export default function App() {
  const [deviceState, setDeviceState] = useState<PersistedDeviceState | null>(null);
  const [records, setRecords] = useState<StoredSosRecord[]>([]);
  const [selectedPacketId, setSelectedPacketId] = useState<string | null>(null);

  const [mainTab, setMainTab] = useState<MainTab>("sos");
  const [radarSubView, setRadarSubView] = useState<RadarSubView>("list");
  const [sosActive, setSosActive] = useState(false);
  const [meshRunning, setMeshRunning] = useState(false);
  const [acousticListening, setAcousticListening] = useState(false);
  const [calibrating, setCalibrating] = useState(false);
  const [sirenActive, setSirenActive] = useState(false);

  const [spectrum, setSpectrum] = useState<NativeSpectrumFrame | null>(null);
  const [thresholdDb, setThresholdDb] = useState(-42.5);
  const [headingDeg, setHeadingDeg] = useState(24);
  const [accelMs2, setAccelMs2] = useState(9.81);
  const [lightLux, setLightLux] = useState(140);
  const [isPocketBag, setIsPocketBag] = useState(false);
  const [batteryPct] = useState(86);

  const [shortNote, setShortNote] = useState("TERJEBAK");
  const [countdownSec, setCountdownSec] = useState<number | null>(null);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [relayedCount, setRelayedCount] = useState(0);
  const [rejectedCount, setRejectedCount] = useState(0);

  const dedupRef = useRef(new PacketDeduplicator(512, SONARMESH_CONSTANTS.DEDUP_WINDOW_MS));
  const deviceStateRef = useRef<PersistedDeviceState | null>(null);
  const sosActiveRef = useRef<boolean>(sosActive);
  const pocketRef = useRef<boolean>(isPocketBag);

  deviceStateRef.current = deviceState;
  sosActiveRef.current = sosActive;
  pocketRef.current = isPocketBag;

  const showToast = useCallback((msg: string) => {
    setToastMsg(msg);
  }, []);

  const dispatchSosPacket = useCallback(
    async (
      triggerType: TriggerType,
      options?: { sirenReq?: boolean; playAcoustic?: boolean }
    ) => {
      const st = deviceStateRef.current;
      if (!st) return;

      const nextSeq = (st.seqCounter + 1) & 0xffff;
      const updatedState: PersistedDeviceState = { ...st, seqCounter: nextSeq };
      setDeviceState(updatedState);
      void packetStore.saveDeviceState(updatedState);

      const raw56 = encodeSmpV1({
        triggerType,
        envPocketBag: pocketRef.current,
        sirenReq: options?.sirenReq ?? false,
        ttl: st.settings.defaultTtl,
        packetId: randomHex(8),
        seqCounter: nextSeq,
        latitude: st.lastLatitude,
        longitude: st.lastLongitude,
        gpsAccBucket: accuracyMetersToBucket(st.lastAccuracyM),
        batteryQuant: batteryPctToQuant(batteryPct),
        ageSec: 0,
        senderHint: st.senderHint,
        powNonce: Math.floor(Math.random() * 4096),
        shortPayload: shortNote.trim().slice(0, 9),
      });

      const localRec = createRecordFromBytes(raw56, {
        transport: options?.playAcoustic ? "ultrasonic" : "ble",
        rssi: -45,
        snrDb: 18,
        relayed: false,
      });
      if (localRec) {
        dedupRef.current.acceptIfFresh(localRec.packet);
        await packetStore.savePacket(localRec);
        setRecords((prev) => [localRec, ...prev].slice(0, 120));
        setSelectedPacketId(localRec.packetId);
      }

      try {
        await sonarMeshBridge.broadcastBle(raw56, 4000);
        if (options?.playAcoustic) {
          await sonarMeshBridge.transmitUltrasonic(raw56);
        }
        showToast(
          options?.playAcoustic
            ? "Sinyal SOS terkirim lewat Bluetooth & suara 19 kHz."
            : "Sinyal SOS disiarkan lewat Bluetooth offline."
        );
      } catch (err) {
        showToast(err instanceof Error ? err.message : "Gagal mengirim sinyal.");
      }
    },
    [batteryPct, shortNote, showToast]
  );

  useEffect(() => {
    let active = true;

    async function boot() {
      const [st, savedPackets] = await Promise.all([
        packetStore.loadDeviceState(),
        packetStore.loadPackets(100),
      ]);
      if (!active) return;

      setDeviceState(st);
      setRecords(savedPackets);
      if (savedPackets.length > 0) {
        setSelectedPacketId(savedPackets[0].packetId);
      }

      dedupRef.current.hydrateSeen(
        savedPackets.map((r) => ({
          packetId: r.packetId,
          senderHint: r.packet.senderHint,
          seqCounter: r.packet.seqCounter,
          seenAtMs: r.receivedAtMs,
        }))
      );

      sonarMeshBridge.attach({
        onPacket: (ev) => {
          const raw = base64ToBytes(ev.packetBase64);
          const decoded = decodeSmpV1(raw);
          if (!decoded.ok) {
            setRejectedCount((c) => c + 1);
            return;
          }
          if (!dedupRef.current.acceptIfFresh(decoded.packet)) {
            return;
          }

          const record = createRecordFromBytes(raw, {
            transport: ev.transport,
            rssi: ev.rssi,
            snrDb: ev.snrDb,
            relayed: ev.relayed,
          });
          if (!record) return;

          void packetStore.savePacket(record);
          setRecords((prev) => [record, ...prev].slice(0, 120));
          setSelectedPacketId((curr) => curr ?? record.packetId);
          showToast(`Sinyal baru diterima: "${record.packet.shortPayload || "SOS"}"`);

          const relayBytes = prepareRelayPacket(decoded.packet, 1);
          if (relayBytes && !sonarMeshBridge.nativeAvailable) {
            const jitterMs =
              SONARMESH_CONSTANTS.RELAY_JITTER_MIN_MS +
              Math.floor(
                Math.random() *
                  (SONARMESH_CONSTANTS.RELAY_JITTER_MAX_MS -
                    SONARMESH_CONSTANTS.RELAY_JITTER_MIN_MS)
              );
            setTimeout(() => {
              void sonarMeshBridge.broadcastBle(relayBytes, 2500);
              setRelayedCount((n) => n + 1);
            }, jitterMs);
          } else if (ev.relayed) {
            setRelayedCount((n) => n + 1);
          }

          const rssiThresh =
            deviceStateRef.current?.settings.pocketProximityRssiDbm ??
            DEFAULT_SONARMESH_SETTINGS.pocketProximityRssiDbm;
          if (
            decoded.packet.sirenReq ||
            (sosActiveRef.current && pocketRef.current && ev.rssi >= rssiThresh)
          ) {
            void sonarMeshBridge.startSiren();
            setSirenActive(true);
            showToast("Penolong terdeteksi dekat. Sirene 3,5 kHz dinyalakan.");
          }
        },
        onSpectrum: (frame) => setSpectrum(frame),
        onCalibration: (res) => {
          setCalibrating(false);
          setThresholdDb(res.thresholdDb);
          showToast(`Kalibrasi ruangan selesai (ambang ${res.thresholdDb.toFixed(1)} dB).`);
        },
        onImpact: (ev) => {
          const sec =
            deviceStateRef.current?.settings.sosCountdownSec ??
            DEFAULT_SONARMESH_SETTINGS.sosCountdownSec;
          setCountdownSec((curr) => (curr === null ? sec : curr));
          showToast(
            `Benturan keras terdeteksi (${ev.magnitudeMs2.toFixed(1)} m/s^2). Batalkan dalam ${sec} detik.`
          );
        },
        onSensors: (snap) => {
          setAccelMs2(snap.accelMagnitudeMs2);
          setLightLux(snap.lightLux);
          setIsPocketBag(snap.isPocketBag);
          setHeadingDeg(snap.headingDeg);
        },
        onError: (msg) => showToast(msg),
      });

      await sonarMeshBridge.startMesh("RADAR", false, st.settings);
      if (active) setMeshRunning(true);
    }

    void boot();
    return () => {
      active = false;
      sonarMeshBridge.detach();
    };
  }, [showToast]);

  useEffect(() => {
    if (countdownSec === null) return;
    if (countdownSec <= 0) {
      setCountdownSec(null);
      setSosActive(true);
      void dispatchSosPacket("SENSOR_SOS", { sirenReq: isPocketBag, playAcoustic: true });
      return;
    }
    const timer = setTimeout(() => {
      setCountdownSec((c) => (c !== null ? c - 1 : null));
    }, 1000);
    return () => clearTimeout(timer);
  }, [countdownSec, dispatchSosPacket, isPocketBag]);

  const handleToggleSos = useCallback(async () => {
    const st = deviceStateRef.current;
    if (!st) return;
    if (sosActive) {
      setSosActive(false);
      await sonarMeshBridge.startMesh("RADAR", false, st.settings);
      showToast("Siaran SOS dihentikan. Kembali ke mode siaga.");
    } else {
      setSosActive(true);
      await sonarMeshBridge.startMesh("SOS", true, st.settings);
      setMeshRunning(true);
      await dispatchSosPacket("MANUAL", { sirenReq: false, playAcoustic: true });
    }
  }, [dispatchSosPacket, showToast, sosActive]);

  const handleToggleAcousticListen = useCallback(async () => {
    const st = deviceStateRef.current;
    if (!st) return;
    if (acousticListening) {
      await sonarMeshBridge.stopAcousticListen();
      setAcousticListening(false);
      showToast("Mikrofon dimatikan untuk menghemat baterai.");
    } else {
      await sonarMeshBridge.startAcousticListen(st.settings);
      setAcousticListening(true);
      showToast("Mendengarkan sinyal ultrasonik 18,5-20 kHz...");
    }
  }, [acousticListening, showToast]);

  const handleCalibrate = useCallback(async () => {
    const st = deviceStateRef.current;
    if (!st) return;
    if (!acousticListening) {
      await sonarMeshBridge.startAcousticListen(st.settings);
      setAcousticListening(true);
    }
    setCalibrating(true);
    showToast("Harap tenang 3 detik untuk mengukur kebisingan ruangan...");
    await sonarMeshBridge.calibrateNoiseFloor(SONARMESH_CONSTANTS.CALIBRATION_DURATION_MS);
  }, [acousticListening, showToast]);

  const handleToggleSiren = useCallback(async () => {
    if (sirenActive) {
      await sonarMeshBridge.stopSiren();
      setSirenActive(false);
      showToast("Sirene 3,5 kHz dimatikan.");
    } else {
      await sonarMeshBridge.startSiren();
      setSirenActive(true);
      showToast("Sirene darurat 3,5 kHz berbunyi.");
    }
  }, [showToast, sirenActive]);

  const updateSetting = useCallback(
    <K extends keyof SonarMeshSettings>(key: K, value: SonarMeshSettings[K]) => {
      setDeviceState((prev) => {
        if (!prev) return prev;
        const next: PersistedDeviceState = {
          ...prev,
          settings: { ...prev.settings, [key]: value },
        };
        void packetStore.saveDeviceState(next);
        void sonarMeshBridge.updateSensorConfig(next.settings);
        return next;
      });
    },
    []
  );

  const selectedRecord = useMemo(
    () => records.find((r) => r.packetId === selectedPacketId) ?? records[0] ?? null,
    [records, selectedPacketId]
  );

  const selectedHex = useMemo(() => {
    if (!selectedRecord) return "";
    return (
      bytesToHex(base64ToBytes(selectedRecord.rawBase64))
        .match(/.{1,4}/g)
        ?.join(" ") ?? ""
    );
  }, [selectedRecord]);

  const renderPacketItem = useCallback(
    ({ item }: { item: StoredSosRecord }) => (
      <SosPacketRow
        record={item}
        selected={item.packetId === selectedRecord?.packetId}
        myLat={deviceState?.lastLatitude ?? -7.257472}
        myLon={deviceState?.lastLongitude ?? 112.752088}
        onSelect={setSelectedPacketId}
      />
    ),
    [deviceState?.lastLatitude, deviceState?.lastLongitude, selectedRecord?.packetId]
  );

  const keyExtractor = useCallback((item: StoredSosRecord) => item.packetId, []);

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.safeArea}>
        <StatusBar style="light" />

        {/* Clean Top App Bar */}
        <View style={styles.headerBar}>
          <View style={styles.brandGroup}>
            <Text style={styles.brandTitle}>SonarMesh</Text>
            <View style={[styles.statusPill, meshRunning ? styles.pillGreen : styles.pillMuted]}>
              <View style={[styles.dot, { backgroundColor: meshRunning ? COLORS.positive : COLORS.muted }]} />
              <Text style={[styles.statusPillText, { color: meshRunning ? COLORS.positive : COLORS.muted }]}>
                {meshRunning ? "Offline Siap" : "Siaga"}
              </Text>
            </View>
          </View>

          <View style={styles.headerRight}>
            {isPocketBag ? (
              <View style={styles.pocketBadge}>
                <Text style={styles.pocketBadgeText}>Di Saku</Text>
              </View>
            ) : null}
            <Text style={styles.battText}>{batteryPct}%</Text>
          </View>
        </View>

        {/* Global Urgent Banners (Countdown or Active Siren) visible across all tabs */}
        {countdownSec !== null ? (
          <View style={styles.urgentBanner}>
            <View style={styles.urgentTextCol}>
              <Text style={styles.urgentTitle}>
                Benturan terdeteksi · SOS dalam {countdownSec} detik
              </Text>
              <Text style={styles.urgentSub}>Ketuk batalkan jika ponsel hanya terjatuh biasa.</Text>
            </View>
            <Pressable
              onPress={() => {
                setCountdownSec(null);
                showToast("Pengiriman SOS otomatis dibatalkan.");
              }}
              style={styles.cancelUrgentBtn}
              accessibilityRole="button"
            >
              <Text style={styles.cancelUrgentText}>Batalkan</Text>
            </Pressable>
          </View>
        ) : null}

        {sirenActive ? (
          <View style={styles.sirenBanner}>
            <Text style={styles.sirenBannerText}>Sirene Darurat 3,5 kHz Menyala</Text>
            <Pressable
              onPress={() => void handleToggleSiren()}
              style={styles.stopSirenChip}
              accessibilityRole="button"
            >
              <Text style={styles.stopSirenChipText}>Matikan</Text>
            </Pressable>
          </View>
        ) : null}

        {toastMsg ? (
          <View style={styles.toastRow}>
            <Text style={styles.toastText}>{toastMsg}</Text>
            <Pressable onPress={() => setToastMsg(null)} accessibilityRole="button">
              <Text style={styles.toastClose}>Tutup</Text>
            </Pressable>
          </View>
        ) : null}

        {/* Main Screen Content */}
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
        >
          {/* TAB 1: SOS EMERGENCY HOME (1 clear focus for anyone in panic) */}
          {mainTab === "sos" ? (
            <View style={styles.sosScreen}>
              <View style={styles.heroIntro}>
                <Text style={styles.heroHeading}>
                  {sosActive ? "Sinyal SOS Sedang Dipancarkan" : "Bantuan Darurat Tanpa Internet"}
                </Text>
                <Text style={styles.heroSub}>
                  {sosActive
                    ? "Ponsel menyiarkan lokasi GPS lewat Bluetooth dan gelombang suara 19 kHz."
                    : "Bekerja 100% di Mode Pesawat lewat Bluetooth dan gelombang suara."}
                </Text>
              </View>

              {/* Unmistakable Tactile Circular SOS Button */}
              <View style={styles.sosCenterWrap}>
                <View style={[styles.sosOuterRing, sosActive ? styles.sosOuterRingActive : null]}>
                  <Pressable
                    onPress={() => void handleToggleSos()}
                    style={[styles.sosCircleBtn, sosActive ? styles.sosCircleBtnActive : null]}
                    accessibilityRole="button"
                    accessibilityLabel={sosActive ? "Hentikan siaran SOS" : "Kirim sinyal SOS darurat"}
                  >
                    <Text style={styles.sosCircleTitle}>
                      {sosActive ? "HENTIKAN" : "SOS"}
                    </Text>
                    <Text style={styles.sosCircleSub}>
                      {sosActive ? "SOS sedang aktif" : "Ketuk untuk kirim"}
                    </Text>
                  </Pressable>
                </View>
              </View>

              {/* Quick Emergency Message Selector (max 9 bytes) */}
              <View style={styles.noteCard}>
                <Text style={styles.cardLabel}>Pesan singkat yang ikut dikirim (maks 9 huruf)</Text>
                <View style={styles.presetRow}>
                  {QUICK_NOTES.map((preset) => {
                    const active = shortNote.trim().toUpperCase() === preset;
                    return (
                      <Pressable
                        key={preset}
                        onPress={() => setShortNote(preset)}
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
                  value={shortNote}
                  onChangeText={setShortNote}
                  maxLength={9}
                  placeholder="Ketik pesan pendek..."
                  placeholderTextColor={COLORS.muted}
                  style={styles.noteInput}
                />
              </View>

              {/* Two Clear Secondary Rescue Controls */}
              <View style={styles.dualActionRow}>
                <Pressable
                  onPress={() => void handleToggleSiren()}
                  style={[styles.bigToolBtn, sirenActive ? styles.bigToolBtnWarn : null]}
                  accessibilityRole="button"
                >
                  <IconSiren color={sirenActive ? COLORS.amber : COLORS.text} size={20} />
                  <Text style={[styles.bigToolTitle, sirenActive ? styles.textAmber : null]}>
                    {sirenActive ? "Matikan Sirene" : "Sirene 3,5 kHz"}
                  </Text>
                  <Text style={styles.bigToolSub}>Panggil penolong sekitar</Text>
                </Pressable>

                <Pressable
                  onPress={() =>
                    void dispatchSosPacket("MANUAL", { playAcoustic: true, sirenReq: false })
                  }
                  style={styles.bigToolBtn}
                  accessibilityRole="button"
                >
                  <IconWave color={COLORS.sonar} size={20} />
                  <Text style={styles.bigToolTitle}>Kirim Ping Suara</Text>
                  <Text style={styles.bigToolSub}>Gelombang 18,5-20 kHz</Text>
                </Pressable>
              </View>

              {/* Compact Bottom Summary Link to Radar */}
              <Pressable
                onPress={() => setMainTab("radar")}
                style={styles.summaryCard}
                accessibilityRole="button"
              >
                <View style={styles.summaryLeft}>
                  <Text style={styles.summaryTitle}>
                    {records.length > 0
                      ? `${records.length} sinyal SOS tersimpan di sekitar`
                      : "Buka Radar Pencari Korban"}
                  </Text>
                  <Text style={styles.summarySub}>
                    GPS terakhir: {(deviceState?.lastLatitude ?? -7.257472).toFixed(4)},{" "}
                    {(deviceState?.lastLongitude ?? 112.752088).toFixed(4)}
                  </Text>
                </View>
                <Text style={styles.summaryAction}>Lihat Radar</Text>
              </Pressable>
            </View>
          ) : null}

          {/* TAB 2: UNIFIED RESCUER RADAR + FFT SPECTRUM + OFFLINE COORDS & FEED (US-005) */}
          {mainTab === "radar" ? (
            <View style={styles.sectionStack}>
              <CompassRadar
                headingDeg={headingDeg}
                myLat={deviceState?.lastLatitude ?? -7.257472}
                myLon={deviceState?.lastLongitude ?? 112.752088}
                records={records}
                selectedPacketId={selectedRecord?.packetId ?? null}
                onSelectPacket={setSelectedPacketId}
              />

              <SpectrumAnalyzer
                frame={spectrum}
                listening={acousticListening}
                calibrating={calibrating}
                freqSpace0Hz={deviceState?.settings.freqSpace0Hz ?? 18750}
                freqMark1Hz={deviceState?.settings.freqMark1Hz ?? 19500}
                thresholdDb={thresholdDb}
                onToggleListen={() => void handleToggleAcousticListen()}
                onCalibrate={() => void handleCalibrate()}
              />

              {/* Segmented Toggle: Daftar Sinyal SOS vs Plot Koordinat Offline */}
              <View style={styles.segmentedBar}>
                <Pressable
                  onPress={() => setRadarSubView("list")}
                  style={[styles.segBtn, radarSubView === "list" ? styles.segBtnActive : null]}
                  accessibilityRole="tab"
                >
                  <Text style={[styles.segText, radarSubView === "list" ? styles.segTextActive : null]}>
                    Daftar Sinyal ({records.length})
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
                records.length === 0 ? (
                  <View style={styles.emptyCard}>
                    <Text style={styles.emptyTitle}>Belum ada sinyal masuk</Text>
                    <Text style={styles.emptySub}>
                      Aktifkan "Dengar Sinyal Suara" di atas atau gunakan tombol simulasi di tab Alat &amp; Tes untuk mencoba alur penerimaan.
                    </Text>
                  </View>
                ) : (
                  <FlatList
                    data={records}
                    renderItem={renderPacketItem}
                    keyExtractor={keyExtractor}
                    scrollEnabled={false}
                  />
                )
              ) : (
                <OfflineCoordinatePlot
                  myLat={deviceState?.lastLatitude ?? -7.257472}
                  myLon={deviceState?.lastLongitude ?? 112.752088}
                  myAccuracyM={deviceState?.lastAccuracyM ?? 12}
                  records={records}
                />
              )}
            </View>
          ) : null}

          {/* TAB 3: SENSORS, CALIBRATION, FIELD SIMULATOR & SMPv1 INSPECTOR */}
          {mainTab === "tools" ? (
            <View style={styles.sectionStack}>
              {/* Live Hardware Sensor Status */}
              <View style={styles.cardBlock}>
                <Text style={styles.blockTitle}>Sensor Otomatis Perangkat</Text>
                <View style={styles.sensorRow}>
                  <View style={styles.sensorTile}>
                    <Text style={styles.sensorLabel}>Guncangan</Text>
                    <Text style={styles.sensorVal}>{accelMs2.toFixed(1)} m/s^2</Text>
                    <Text style={styles.sensorHint}>
                      Batas: {(deviceState?.settings.impactThresholdMs2 ?? 28).toFixed(0)} m/s^2
                    </Text>
                  </View>
                  <View style={styles.sensorTile}>
                    <Text style={styles.sensorLabel}>Cahaya Sekitar</Text>
                    <Text style={styles.sensorVal}>{lightLux.toFixed(0)} lux</Text>
                    <Text style={styles.sensorHint}>
                      {isPocketBag ? "Terdeteksi di saku/tas" : "Ruang terbuka"}
                    </Text>
                  </View>
                </View>

                <View style={styles.settingList}>
                  <View style={styles.settingRow}>
                    <Text style={styles.settingLabel}>
                      Ambang benturan ({(deviceState?.settings.impactThresholdMs2 ?? 28).toFixed(0)} m/s^2)
                    </Text>
                    <View style={styles.stepper}>
                      <Pressable
                        onPress={() =>
                          updateSetting(
                            "impactThresholdMs2",
                            Math.max(16, (deviceState?.settings.impactThresholdMs2 ?? 28) - 2)
                          )
                        }
                        style={styles.stepBtn}
                      >
                        <Text style={styles.stepText}>-</Text>
                      </Pressable>
                      <Pressable
                        onPress={() =>
                          updateSetting(
                            "impactThresholdMs2",
                            Math.min(48, (deviceState?.settings.impactThresholdMs2 ?? 28) + 2)
                          )
                        }
                        style={styles.stepBtn}
                      >
                        <Text style={styles.stepText}>+</Text>
                      </Pressable>
                    </View>
                  </View>

                  <View style={styles.settingRow}>
                    <Text style={styles.settingLabel}>
                      Ambang gelap saku ({(deviceState?.settings.pocketLuxThreshold ?? 5).toFixed(0)} lux)
                    </Text>
                    <View style={styles.stepper}>
                      <Pressable
                        onPress={() =>
                          updateSetting(
                            "pocketLuxThreshold",
                            Math.max(1, (deviceState?.settings.pocketLuxThreshold ?? 5) - 1)
                          )
                        }
                        style={styles.stepBtn}
                      >
                        <Text style={styles.stepText}>-</Text>
                      </Pressable>
                      <Pressable
                        onPress={() =>
                          updateSetting(
                            "pocketLuxThreshold",
                            Math.min(25, (deviceState?.settings.pocketLuxThreshold ?? 5) + 1)
                          )
                        }
                        style={styles.stepBtn}
                      >
                        <Text style={styles.stepText}>+</Text>
                      </Pressable>
                    </View>
                  </View>

                  <View style={styles.settingRow}>
                    <Text style={styles.settingLabel}>
                      Durasi simbol FSK ({deviceState?.settings.symbolDurationMs ?? 20} ms)
                    </Text>
                    <View style={styles.stepper}>
                      <Pressable
                        onPress={() =>
                          updateSetting(
                            "symbolDurationMs",
                            Math.max(10, (deviceState?.settings.symbolDurationMs ?? 20) - 5)
                          )
                        }
                        style={styles.stepBtn}
                      >
                        <Text style={styles.stepText}>-</Text>
                      </Pressable>
                      <Pressable
                        onPress={() =>
                          updateSetting(
                            "symbolDurationMs",
                            Math.min(40, (deviceState?.settings.symbolDurationMs ?? 20) + 5)
                          )
                        }
                        style={styles.stepBtn}
                      >
                        <Text style={styles.stepText}>+</Text>
                      </Pressable>
                    </View>
                  </View>
                </View>

                <Pressable
                  onPress={() =>
                    void sonarMeshBridge
                      .requestIgnoreBatteryOptimizations()
                      .then((ok) =>
                        showToast(
                          ok
                            ? "Aplikasi sudah bebas dari pembatasan baterai."
                            : "Membuka pengaturan pengecualian baterai Android."
                        )
                      )
                  }
                  style={styles.outlineBtn}
                  accessibilityRole="button"
                >
                  <Text style={styles.outlineBtnText}>
                    Izinkan Berjalan di Latar Belakang (Baterai)
                  </Text>
                </Pressable>
              </View>

              {/* Simulator & Uji Lapangan */}
              <View style={styles.cardBlock}>
                <Text style={styles.blockTitle}>Mode Uji &amp; Simulator</Text>
                <Text style={styles.blockSub}>
                  Gunakan tombol ini saat mengetes sensor atau penerimaan sinyal tanpa dua ponsel.
                </Text>
                <View style={styles.simGrid}>
                  <Pressable
                    onPress={() => sonarMeshBridge.simulateImpactShock(35.2)}
                    style={styles.simBtn}
                  >
                    <Text style={styles.simBtnText}>Tes Benturan</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => sonarMeshBridge.simulatePocketToggle(!isPocketBag)}
                    style={styles.simBtn}
                  >
                    <Text style={styles.simBtnText}>
                      {isPocketBag ? "Ubah: Terbuka" : "Ubah: Di Saku"}
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={() => {
                      sonarMeshBridge.injectSimulatedInboundPacket(
                        deviceState?.lastLatitude ?? -7.257472,
                        deviceState?.lastLongitude ?? 112.752088,
                        "ble"
                      );
                      setMainTab("radar");
                    }}
                    style={styles.simBtn}
                  >
                    <Text style={styles.simBtnText}>Simulasi Sinyal BLE</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => {
                      sonarMeshBridge.injectSimulatedInboundPacket(
                        deviceState?.lastLatitude ?? -7.257472,
                        deviceState?.lastLongitude ?? 112.752088,
                        "ultrasonic"
                      );
                      setMainTab("radar");
                    }}
                    style={styles.simBtn}
                  >
                    <Text style={styles.simBtnText}>Simulasi 19 kHz</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => sonarMeshBridge.simulateCompassShift(35)}
                    style={styles.simBtn}
                  >
                    <Text style={styles.simBtnText}>Putar Kompas +35°</Text>
                  </Pressable>
                  <Pressable
                    onPress={async () => {
                      await packetStore.clearPackets();
                      dedupRef.current.clear();
                      setRecords([]);
                      setSelectedPacketId(null);
                      showToast("Riwayat paket lokal dibersihkan.");
                    }}
                    style={[styles.simBtn, styles.simBtnDanger]}
                  >
                    <Text style={styles.simBtnDangerText}>Hapus Riwayat</Text>
                  </Pressable>
                </View>
              </View>

              {/* Technical SMPv1 Protocol Inspector (cleanly tucked here, not on main SOS screen) */}
              <View style={styles.cardBlock}>
                <Text style={styles.blockTitle}>Diagnostik Protokol SMPv1 (56 Byte)</Text>
                <Text style={styles.blockSub}>
                  Runtime: {sonarMeshBridge.runtimeLabel} · Node{" "}
                  {(deviceState?.senderHint ?? "--------").toUpperCase()} · Diteruskan: {relayedCount} · Ditolak: {rejectedCount}
                </Text>
                {selectedRecord ? (
                  <View style={styles.hexBox}>
                    <Text style={styles.hexLabel}>
                      Paket terpilih ({selectedRecord.packetId}) · CRC-16 valid
                    </Text>
                    <Text style={styles.hexCode} selectable>
                      {selectedHex}
                    </Text>
                  </View>
                ) : (
                  <Text style={styles.emptyDiag}>Belum ada frame biner untuk diinspeksi.</Text>
                )}
              </View>
            </View>
          ) : null}
        </ScrollView>

        {/* Native-Style Fixed Bottom Navigation Bar */}
        <View style={styles.bottomNav}>
          <Pressable
            onPress={() => setMainTab("sos")}
            style={styles.navItem}
            accessibilityRole="tab"
          >
            <IconSosBeacon
              color={mainTab === "sos" ? (sosActive ? COLORS.sos : COLORS.sonar) : COLORS.muted}
              size={22}
            />
            <Text
              style={[
                styles.navLabel,
                mainTab === "sos" ? styles.navLabelActive : null,
              ]}
            >
              Darurat
            </Text>
          </Pressable>

          <Pressable
            onPress={() => setMainTab("radar")}
            style={styles.navItem}
            accessibilityRole="tab"
          >
            <View style={styles.navIconWrap}>
              <IconRadar color={mainTab === "radar" ? COLORS.sonar : COLORS.muted} size={22} />
              {records.length > 0 ? (
                <View style={styles.navBadge}>
                  <Text style={styles.navBadgeText}>
                    {records.length > 9 ? "9+" : records.length}
                  </Text>
                </View>
              ) : null}
            </View>
            <Text
              style={[
                styles.navLabel,
                mainTab === "radar" ? styles.navLabelActive : null,
              ]}
            >
              Radar
            </Text>
          </Pressable>

          <Pressable
            onPress={() => setMainTab("tools")}
            style={styles.navItem}
            accessibilityRole="tab"
          >
            <IconLab color={mainTab === "tools" ? COLORS.sonar : COLORS.muted} size={22} />
            <Text
              style={[
                styles.navLabel,
                mainTab === "tools" ? styles.navLabelActive : null,
              ]}
            >
              Alat &amp; Tes
            </Text>
          </Pressable>
        </View>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: COLORS.ground,
  },
  headerBar: {
    height: 54,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.rule,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: COLORS.ground,
  },
  brandGroup: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  brandTitle: {
    color: COLORS.text,
    fontSize: 18,
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
  },
  pillGreen: { backgroundColor: COLORS.positiveSoft },
  pillMuted: { backgroundColor: COLORS.surfaceElevated },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  statusPillText: {
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
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  pocketBadgeText: {
    color: COLORS.amber,
    fontSize: 11,
    fontWeight: "700",
  },
  battText: {
    color: COLORS.muted,
    fontSize: 12,
    fontWeight: "600",
    fontVariant: ["tabular-nums"],
  },
  urgentBanner: {
    backgroundColor: COLORS.sosSoft,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.sos,
    paddingHorizontal: 16,
    paddingVertical: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  urgentTextCol: {
    flex: 1,
  },
  urgentTitle: {
    color: COLORS.text,
    fontSize: 14,
    fontWeight: "700",
  },
  urgentSub: {
    color: COLORS.muted,
    fontSize: 12,
    marginTop: 2,
  },
  cancelUrgentBtn: {
    backgroundColor: COLORS.text,
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 8,
  },
  cancelUrgentText: {
    color: COLORS.ground,
    fontSize: 12,
    fontWeight: "700",
  },
  sirenBanner: {
    backgroundColor: COLORS.amberSoft,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.amber,
    paddingHorizontal: 16,
    paddingVertical: 9,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  sirenBannerText: {
    color: COLORS.amber,
    fontSize: 13,
    fontWeight: "700",
  },
  stopSirenChip: {
    backgroundColor: COLORS.amber,
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 6,
  },
  stopSirenChipText: {
    color: COLORS.ground,
    fontSize: 12,
    fontWeight: "700",
  },
  toastRow: {
    backgroundColor: COLORS.surfaceElevated,
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
    color: COLORS.text,
    fontSize: 12,
    flex: 1,
  },
  toastClose: {
    color: COLORS.sonar,
    fontSize: 12,
    fontWeight: "600",
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    padding: 16,
    paddingBottom: 28,
    maxWidth: 560,
    width: "100%",
    alignSelf: "center",
  },
  sosScreen: {
    gap: 18,
  },
  heroIntro: {
    alignItems: "center",
    paddingHorizontal: 8,
  },
  heroHeading: {
    color: COLORS.text,
    fontSize: 20,
    fontWeight: "700",
    textAlign: "center",
  },
  heroSub: {
    color: COLORS.muted,
    fontSize: 13,
    lineHeight: 19,
    textAlign: "center",
    marginTop: 6,
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
    borderWidth: 1,
    borderColor: COLORS.sos,
  },
  sosOuterRingActive: {
    backgroundColor: COLORS.sosSoft,
    borderWidth: 2,
    borderColor: COLORS.sos,
  },
  sosCircleBtn: {
    width: 166,
    height: 166,
    borderRadius: 83,
    backgroundColor: COLORS.sosFill,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 14,
  },
  sosCircleBtnActive: {
    backgroundColor: COLORS.surface,
    borderWidth: 2,
    borderColor: COLORS.sos,
  },
  sosCircleTitle: {
    color: "#FFFFFF",
    fontSize: 30,
    fontWeight: "800",
    letterSpacing: 1,
  },
  sosCircleSub: {
    color: "#FDECEC",
    fontSize: 12,
    fontWeight: "600",
    marginTop: 4,
    textAlign: "center",
  },
  noteCard: {
    backgroundColor: COLORS.surface,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: 14,
    padding: 14,
    gap: 10,
  },
  cardLabel: {
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
    backgroundColor: COLORS.surfaceElevated,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  presetChipActive: {
    backgroundColor: COLORS.sonarSoft,
    borderColor: COLORS.sonar,
  },
  presetText: {
    color: COLORS.muted,
    fontSize: 12,
    fontWeight: "600",
  },
  presetTextActive: {
    color: COLORS.sonar,
  },
  noteInput: {
    height: 42,
    backgroundColor: COLORS.ground,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
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
  },
  bigToolBtnWarn: {
    backgroundColor: COLORS.amberSoft,
    borderColor: COLORS.amber,
  },
  bigToolTitle: {
    color: COLORS.text,
    fontSize: 14,
    fontWeight: "700",
    marginTop: 4,
  },
  bigToolSub: {
    color: COLORS.muted,
    fontSize: 11,
  },
  textAmber: {
    color: COLORS.amber,
  },
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
  },
  summaryLeft: {
    flex: 1,
    gap: 3,
  },
  summaryTitle: {
    color: COLORS.text,
    fontSize: 14,
    fontWeight: "600",
  },
  summarySub: {
    color: COLORS.muted,
    fontSize: 12,
    fontVariant: ["tabular-nums"],
  },
  summaryAction: {
    color: COLORS.sonar,
    fontSize: 13,
    fontWeight: "700",
  },
  sectionStack: {
    gap: 14,
  },
  segmentedBar: {
    flexDirection: "row",
    backgroundColor: COLORS.surface,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: 10,
    padding: 4,
    gap: 4,
  },
  segBtn: {
    flex: 1,
    paddingVertical: 9,
    borderRadius: 7,
    alignItems: "center",
  },
  segBtnActive: {
    backgroundColor: COLORS.surfaceElevated,
  },
  segText: {
    color: COLORS.muted,
    fontSize: 13,
    fontWeight: "600",
  },
  segTextActive: {
    color: COLORS.text,
  },
  emptyCard: {
    backgroundColor: COLORS.surface,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderStyle: "dashed",
    borderRadius: 12,
    padding: 20,
    alignItems: "center",
  },
  emptyTitle: {
    color: COLORS.text,
    fontSize: 14,
    fontWeight: "700",
  },
  emptySub: {
    color: COLORS.muted,
    fontSize: 12,
    lineHeight: 18,
    marginTop: 6,
    textAlign: "center",
  },
  cardBlock: {
    backgroundColor: COLORS.surface,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: 14,
    padding: 16,
    gap: 12,
  },
  blockTitle: {
    color: COLORS.text,
    fontSize: 15,
    fontWeight: "700",
  },
  blockSub: {
    color: COLORS.muted,
    fontSize: 12,
    lineHeight: 18,
  },
  sensorRow: {
    flexDirection: "row",
    gap: 10,
  },
  sensorTile: {
    flex: 1,
    backgroundColor: COLORS.ground,
    borderColor: COLORS.rule,
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
  },
  sensorLabel: {
    color: COLORS.muted,
    fontSize: 11,
    fontWeight: "600",
  },
  sensorVal: {
    color: COLORS.text,
    fontSize: 18,
    fontWeight: "700",
    marginTop: 4,
    fontVariant: ["tabular-nums"],
  },
  sensorHint: {
    color: COLORS.muted,
    fontSize: 11,
    marginTop: 2,
  },
  settingList: {
    gap: 10,
  },
  settingRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  settingLabel: {
    color: COLORS.text,
    fontSize: 13,
    fontVariant: ["tabular-nums"],
  },
  stepper: {
    flexDirection: "row",
    gap: 8,
  },
  stepBtn: {
    width: 34,
    height: 32,
    borderRadius: 8,
    backgroundColor: COLORS.surfaceElevated,
    borderWidth: 1,
    borderColor: COLORS.border,
    alignItems: "center",
    justifyContent: "center",
  },
  stepText: {
    color: COLORS.text,
    fontSize: 16,
    fontWeight: "700",
  },
  outlineBtn: {
    minHeight: 44,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: COLORS.sonar,
    backgroundColor: COLORS.sonarSoft,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 12,
  },
  outlineBtnText: {
    color: COLORS.sonar,
    fontSize: 13,
    fontWeight: "600",
  },
  simGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  simBtn: {
    width: "48%",
    minHeight: 42,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.surfaceElevated,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 8,
  },
  simBtnText: {
    color: COLORS.text,
    fontSize: 12,
    fontWeight: "600",
  },
  simBtnDanger: {
    backgroundColor: COLORS.sosSoft,
    borderColor: COLORS.sos,
  },
  simBtnDangerText: {
    color: COLORS.sos,
    fontSize: 12,
    fontWeight: "700",
  },
  hexBox: {
    backgroundColor: COLORS.ground,
    borderColor: COLORS.rule,
    borderWidth: 1,
    borderRadius: 8,
    padding: 10,
    gap: 4,
  },
  hexLabel: {
    color: COLORS.positive,
    fontSize: 11,
    fontWeight: "600",
  },
  hexCode: {
    color: COLORS.muted,
    fontSize: 11,
    lineHeight: 17,
    fontVariant: ["tabular-nums"],
  },
  emptyDiag: {
    color: COLORS.muted,
    fontSize: 12,
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
  navIconWrap: {
    position: "relative",
  },
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
    color: "#FFFFFF",
    fontSize: 10,
    fontWeight: "700",
  },
  navLabel: {
    color: COLORS.muted,
    fontSize: 11,
    fontWeight: "600",
  },
  navLabelActive: {
    color: COLORS.text,
  },
});
