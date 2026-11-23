import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FlatList,
  Platform,
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
import { COLORS } from "@/theme/tokens";

type OperatingMode = "RADAR" | "SOS";
type LowerTab = "feed" | "coords" | "lab";

export default function App() {
  const [deviceState, setDeviceState] = useState<PersistedDeviceState | null>(null);
  const [records, setRecords] = useState<StoredSosRecord[]>([]);
  const [selectedPacketId, setSelectedPacketId] = useState<string | null>(null);

  const [mode, setMode] = useState<OperatingMode>("RADAR");
  const [lowerTab, setLowerTab] = useState<LowerTab>("feed");
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

  const [shortNote, setShortNote] = useState("SOS HERE");
  const [countdownSec, setCountdownSec] = useState<number | null>(null);
  const [statusBanner, setStatusBanner] = useState<string | null>(null);
  const [relayedCount, setRelayedCount] = useState(0);
  const [rejectedCount, setRejectedCount] = useState(0);

  const dedupRef = useRef(new PacketDeduplicator(512, SONARMESH_CONSTANTS.DEDUP_WINDOW_MS));
  const deviceStateRef = useRef<PersistedDeviceState | null>(null);
  const modeRef = useRef<OperatingMode>(mode);
  const pocketRef = useRef<boolean>(isPocketBag);

  deviceStateRef.current = deviceState;
  modeRef.current = mode;
  pocketRef.current = isPocketBag;

  const pushBanner = useCallback((msg: string) => {
    setStatusBanner(msg);
  }, []);

  // Trigger full SOS broadcast over BLE + Ultrasonic 56-byte SMPv1
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
        pushBanner(
          `Transmitted 56B SMPv1 (${triggerType}) via ${options?.playAcoustic ? "Ultrasonic + BLE" : "BLE"}.`
        );
      } catch (err) {
        pushBanner(err instanceof Error ? err.message : "Transmission failed.");
      }
    },
    [batteryPct, pushBanner, shortNote]
  );

  // Boot offline storage, hydrate deduplicator, and wire native/loopback bridge
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
            pushBanner(`Rejected corrupt packet: ${decoded.message}`);
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

          // Relay scheduling in JS fallback when TTL > 1
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

          // Pocket-aware 3.5 kHz siren trigger (US-004):
          // Activate if SIREN_REQ=1 or pocketed SOS detects nearby responder RSSI
          const rssiThresh =
            deviceStateRef.current?.settings.pocketProximityRssiDbm ??
            DEFAULT_SONARMESH_SETTINGS.pocketProximityRssiDbm;
          if (
            decoded.packet.sirenReq ||
            (modeRef.current === "SOS" && pocketRef.current && ev.rssi >= rssiThresh)
          ) {
            void sonarMeshBridge.startSiren();
            setSirenActive(true);
            pushBanner("3.5 kHz rescue siren triggered by proximity or SIREN_REQ.");
          }
        },
        onSpectrum: (frame) => {
          setSpectrum(frame);
        },
        onCalibration: (res) => {
          setCalibrating(false);
          setThresholdDb(res.thresholdDb);
          pushBanner(
            `Noise calibration complete: floor ${res.noiseFloorDb.toFixed(1)} dB, threshold ${res.thresholdDb.toFixed(1)} dB.`
          );
        },
        onImpact: (ev) => {
          const sec =
            deviceStateRef.current?.settings.sosCountdownSec ??
            DEFAULT_SONARMESH_SETTINGS.sosCountdownSec;
          setCountdownSec((curr) => (curr === null ? sec : curr));
          pushBanner(
            `Impact shock detected (${ev.magnitudeMs2.toFixed(1)} m/s^2). Cancel within ${sec}s to abort SOS.`
          );
        },
        onSensors: (snap) => {
          setAccelMs2(snap.accelMagnitudeMs2);
          setLightLux(snap.lightLux);
          setIsPocketBag(snap.isPocketBag);
          setHeadingDeg(snap.headingDeg);
        },
        onError: (msg) => {
          pushBanner(`Hardware alert: ${msg}`);
        },
      });

      await sonarMeshBridge.startMesh("RADAR", false, st.settings);
      if (active) {
        setMeshRunning(true);
      }
    }

    void boot();
    return () => {
      active = false;
      sonarMeshBridge.detach();
    };
  }, [pushBanner]);

  // Accelerometer impact SOS countdown timer (US-004)
  useEffect(() => {
    if (countdownSec === null) return;
    if (countdownSec <= 0) {
      setCountdownSec(null);
      setMode("SOS");
      void dispatchSosPacket("SENSOR_SOS", { sirenReq: isPocketBag, playAcoustic: true });
      return;
    }
    const timer = setTimeout(() => {
      setCountdownSec((c) => (c !== null ? c - 1 : null));
    }, 1000);
    return () => clearTimeout(timer);
  }, [countdownSec, dispatchSosPacket, isPocketBag]);

  const handleModeSwitch = useCallback(
    async (nextMode: OperatingMode) => {
      setMode(nextMode);
      const st = deviceStateRef.current;
      if (!st) return;
      await sonarMeshBridge.startMesh(nextMode, nextMode === "SOS", st.settings);
      setMeshRunning(true);
      if (nextMode === "SOS") {
        await dispatchSosPacket("MANUAL", { sirenReq: false, playAcoustic: true });
      }
    },
    [dispatchSosPacket]
  );

  const handleToggleAcousticListen = useCallback(async () => {
    const st = deviceStateRef.current;
    if (!st) return;
    if (acousticListening) {
      await sonarMeshBridge.stopAcousticListen();
      setAcousticListening(false);
      pushBanner("Microphone capture stopped (battery saved).");
    } else {
      await sonarMeshBridge.startAcousticListen(st.settings);
      setAcousticListening(true);
      pushBanner("Listening on 18.5-20 kHz via 48 kHz AudioRecord FFT.");
    }
  }, [acousticListening, pushBanner]);

  const handleCalibrate = useCallback(async () => {
    const st = deviceStateRef.current;
    if (!st) return;
    if (!acousticListening) {
      await sonarMeshBridge.startAcousticListen(st.settings);
      setAcousticListening(true);
    }
    setCalibrating(true);
    pushBanner("Measuring ambient room noise floor for 3 seconds...");
    await sonarMeshBridge.calibrateNoiseFloor(SONARMESH_CONSTANTS.CALIBRATION_DURATION_MS);
  }, [acousticListening, pushBanner]);

  const handleToggleSiren = useCallback(async () => {
    if (sirenActive) {
      await sonarMeshBridge.stopSiren();
      setSirenActive(false);
      pushBanner("3.5 kHz siren silenced.");
    } else {
      await sonarMeshBridge.startSiren();
      setSirenActive(true);
      pushBanner("Playing 3.5 kHz rescue siren.");
    }
  }, [pushBanner, sirenActive]);

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
    return bytesToHex(base64ToBytes(selectedRecord.rawBase64))
      .match(/.{1,4}/g)
      ?.join(" ") ?? "";
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
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.container}
          keyboardShouldPersistTaps="handled"
        >
          {/* Top Tactical Header */}
          <View style={styles.topBar}>
            <View>
              <View style={styles.brandRow}>
                <Text style={styles.brandName}>SonarMesh</Text>
                <View style={styles.offlineBadge}>
                  <Text style={styles.offlineBadgeText}>OFFLINE · AIRPLANE READY</Text>
                </View>
              </View>
              <Text style={styles.runtimeSub}>
                SMPv1 56B · {sonarMeshBridge.runtimeLabel} · Node{" "}
                {(deviceState?.senderHint ?? "--------").toUpperCase()}
              </Text>
            </View>

            {/* Mode Switcher: RADAR / MONITOR vs BEACON / SOS */}
            <View style={styles.modeSwitch}>
              <Pressable
                onPress={() => void handleModeSwitch("RADAR")}
                style={[styles.modeBtn, mode === "RADAR" ? styles.modeBtnRadar : null]}
                accessibilityRole="button"
              >
                <Text style={[styles.modeBtnText, mode === "RADAR" ? styles.modeBtnTextActive : null]}>
                  Radar
                </Text>
              </Pressable>
              <Pressable
                onPress={() => void handleModeSwitch("SOS")}
                style={[styles.modeBtn, mode === "SOS" ? styles.modeBtnSos : null]}
                accessibilityRole="button"
              >
                <Text style={[styles.modeBtnText, mode === "SOS" ? styles.modeBtnTextSos : null]}>
                  SOS Beacon
                </Text>
              </Pressable>
            </View>
          </View>

          {/* Status Strip: ENV_STATE, Mesh Service, Relays, Battery */}
          <View style={styles.statusStrip}>
            <Text style={styles.stripItem}>
              ENV: <Text style={isPocketBag ? styles.textAmber : styles.textSonar}>{isPocketBag ? "POCKET/BAG" : "OPEN"}</Text> ({Math.round(lightLux)} lx)
            </Text>
            <Text style={styles.stripItem}>
              MESH: <Text style={meshRunning ? styles.textPos : styles.textMuted}>{meshRunning ? "ACTIVE" : "OFF"}</Text>
            </Text>
            <Text style={styles.stripItem}>RELAYED: {relayedCount}</Text>
            <Text style={styles.stripItem}>BATT: {batteryPct}%</Text>
          </View>

          {/* Accelerometer Impact Countdown Banner */}
          {countdownSec !== null ? (
            <View style={styles.countdownCard}>
              <View style={styles.countdownCopy}>
                <Text style={styles.countdownTitle}>
                  IMPACT DETECTED · AUTO-SOS IN {countdownSec}s
                </Text>
                <Text style={styles.countdownSub}>
                  Cancel immediately if this drop was accidental.
                </Text>
              </View>
              <Pressable
                onPress={() => {
                  setCountdownSec(null);
                  pushBanner("Impact SOS countdown cancelled.");
                }}
                style={styles.cancelCountdownBtn}
                accessibilityRole="button"
              >
                <Text style={styles.cancelCountdownText}>CANCEL COUNTDOWN</Text>
              </Pressable>
            </View>
          ) : null}

          {/* Status Notice */}
          {statusBanner ? (
            <View style={styles.noticeRow}>
              <Text style={styles.noticeText}>{statusBanner}</Text>
              <Pressable onPress={() => setStatusBanner(null)} accessibilityRole="button">
                <Text style={styles.noticeDismiss}>Dismiss</Text>
              </Pressable>
            </View>
          ) : null}

          {/* High-Contrast Primary Controls */}
          <View style={styles.controlDeck}>
            <Pressable
              onPress={() =>
                void (mode === "SOS"
                  ? handleModeSwitch("RADAR")
                  : handleModeSwitch("SOS"))
              }
              style={[
                styles.primarySosBtn,
                mode === "SOS" ? styles.primarySosBtnActive : null,
              ]}
              accessibilityRole="button"
            >
              <Text style={styles.primarySosText}>
                {mode === "SOS" ? "STOP SOS BEACON" : "TRIGGER SOS (BLE + 19kHz)"}
              </Text>
            </Pressable>

            <View style={styles.secondaryControls}>
              <Pressable
                onPress={() =>
                  void dispatchSosPacket("MANUAL", { playAcoustic: true, sirenReq: false })
                }
                style={styles.secondaryBtn}
                accessibilityRole="button"
              >
                <Text style={styles.secondaryBtnText}>TX Ultrasonic 56B</Text>
              </Pressable>

              <Pressable
                onPress={() => void handleToggleSiren()}
                style={[styles.secondaryBtn, sirenActive ? styles.sirenBtnActive : null]}
                accessibilityRole="button"
              >
                <Text style={[styles.secondaryBtnText, sirenActive ? styles.sirenBtnTextActive : null]}>
                  {sirenActive ? "STOP SIREN (3.5 kHz)" : "Play Siren 3.5 kHz"}
                </Text>
              </Pressable>
            </View>
          </View>

          {/* Unified Telemetry Visuals: Relative Compass Radar + 18.5-20 kHz FFT Spectrum */}
          <View style={styles.telemetryGrid}>
            <View style={styles.telemetryCol}>
              <CompassRadar
                headingDeg={headingDeg}
                myLat={deviceState?.lastLatitude ?? -7.257472}
                myLon={deviceState?.lastLongitude ?? 112.752088}
                records={records}
                selectedPacketId={selectedRecord?.packetId ?? null}
                onSelectPacket={setSelectedPacketId}
              />
            </View>

            <View style={styles.telemetryCol}>
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
            </View>
          </View>

          {/* Lower Operational Panel Tabs */}
          <View style={styles.tabBar}>
            {(
              [
                { id: "feed", label: `SOS Feed (${records.length})` },
                { id: "coords", label: "Offline Coords" },
                { id: "lab", label: "Sensors & Lab" },
              ] as const
            ).map((t) => {
              const active = lowerTab === t.id;
              return (
                <Pressable
                  key={t.id}
                  onPress={() => setLowerTab(t.id)}
                  style={[styles.tabBtn, active ? styles.tabBtnActive : null]}
                  accessibilityRole="tab"
                >
                  <Text style={[styles.tabText, active ? styles.tabTextActive : null]}>
                    {t.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          {/* TAB 1: SOS Packet Feed + 56-Byte Hex Inspector */}
          {lowerTab === "feed" ? (
            <View style={styles.panel}>
              <View style={styles.noteInputRow}>
                <TextInput
                  value={shortNote}
                  onChangeText={setShortNote}
                  maxLength={9}
                  placeholder="9B SOS note"
                  placeholderTextColor={COLORS.muted}
                  style={styles.noteInput}
                  accessibilityLabel="Short 9-byte SOS payload"
                />
                <Pressable
                  onPress={() =>
                    sonarMeshBridge.injectSimulatedInboundPacket(
                      deviceState?.lastLatitude ?? -7.257472,
                      deviceState?.lastLongitude ?? 112.752088,
                      "ble"
                    )
                  }
                  style={styles.smallActionBtn}
                  accessibilityRole="button"
                >
                  <Text style={styles.smallActionText}>+ Sim BLE</Text>
                </Pressable>
                <Pressable
                  onPress={() =>
                    sonarMeshBridge.injectSimulatedInboundPacket(
                      deviceState?.lastLatitude ?? -7.257472,
                      deviceState?.lastLongitude ?? 112.752088,
                      "ultrasonic"
                    )
                  }
                  style={styles.smallActionBtn}
                  accessibilityRole="button"
                >
                  <Text style={styles.smallActionText}>+ Sim 19kHz</Text>
                </Pressable>
              </View>

              {records.length === 0 ? (
                <View style={styles.emptyBox}>
                  <Text style={styles.emptyTitle}>No SOS packets stored offline</Text>
                  <Text style={styles.emptySub}>
                    Tap "Trigger SOS", "TX Ultrasonic 56B", or "+ Sim BLE / + Sim 19kHz" to inspect live 56-byte SMPv1 framing and radar plots.
                  </Text>
                </View>
              ) : (
                <FlatList
                  data={records}
                  renderItem={renderPacketItem}
                  keyExtractor={keyExtractor}
                  scrollEnabled={false}
                />
              )}

              {selectedRecord ? (
                <View style={styles.hexBox}>
                  <Text style={styles.hexTitle}>
                    SMPv1 56-Byte Big-Endian Frame · CRC-16 Verified · Rejected: {rejectedCount}
                  </Text>
                  <Text style={styles.hexBody} selectable>
                    {selectedHex}
                  </Text>
                </View>
              ) : null}
            </View>
          ) : null}

          {/* TAB 2: Offline Coordinate Grid & Distance Table */}
          {lowerTab === "coords" ? (
            <View style={styles.panel}>
              <OfflineCoordinatePlot
                myLat={deviceState?.lastLatitude ?? -7.257472}
                myLon={deviceState?.lastLongitude ?? 112.752088}
                myAccuracyM={deviceState?.lastAccuracyM ?? 12}
                records={records}
              />
            </View>
          ) : null}

          {/* TAB 3: Sensors, Thresholds, Battery Optimization & Bench Simulator */}
          {lowerTab === "lab" ? (
            <View style={styles.panel}>
              <View style={styles.sensorGrid}>
                <View style={styles.sensorTile}>
                  <Text style={styles.sensorLabel}>Accelerometer</Text>
                  <Text style={styles.sensorValue}>{accelMs2.toFixed(2)} m/s^2</Text>
                  <Text style={styles.sensorSub}>
                    Trigger &gt;= {(deviceState?.settings.impactThresholdMs2 ?? 28).toFixed(1)} m/s^2
                  </Text>
                </View>
                <View style={styles.sensorTile}>
                  <Text style={styles.sensorLabel}>Light Sensor</Text>
                  <Text style={styles.sensorValue}>{lightLux.toFixed(1)} lux</Text>
                  <Text style={styles.sensorSub}>
                    Pocket &lt;= {(deviceState?.settings.pocketLuxThreshold ?? 5).toFixed(1)} lux
                  </Text>
                </View>
              </View>

              <View style={styles.labActions}>
                <Pressable
                  onPress={() => sonarMeshBridge.simulateImpactShock(35.2)}
                  style={styles.labBtn}
                  accessibilityRole="button"
                >
                  <Text style={styles.labBtnText}>Simulate Impact Shock</Text>
                </Pressable>

                <Pressable
                  onPress={() => sonarMeshBridge.simulatePocketToggle(!isPocketBag)}
                  style={styles.labBtn}
                  accessibilityRole="button"
                >
                  <Text style={styles.labBtnText}>
                    {isPocketBag ? "Set Light: OPEN" : "Set Light: POCKET/BAG"}
                  </Text>
                </Pressable>

                <Pressable
                  onPress={() => sonarMeshBridge.simulateCompassShift(35)}
                  style={styles.labBtn}
                  accessibilityRole="button"
                >
                  <Text style={styles.labBtnText}>Rotate Heading +35°</Text>
                </Pressable>

                <Pressable
                  onPress={() =>
                    void sonarMeshBridge
                      .requestIgnoreBatteryOptimizations()
                      .then((ok) =>
                        pushBanner(
                          ok
                            ? "Battery optimization already bypassed."
                            : "Opened Android battery exemption dialog."
                        )
                      )
                  }
                  style={styles.labBtn}
                  accessibilityRole="button"
                >
                  <Text style={styles.labBtnText}>Battery Exemption</Text>
                </Pressable>
              </View>

              {/* Tunable Protocol & Sensor Constants */}
              <View style={styles.configCard}>
                <Text style={styles.configTitle}>FSK &amp; Trigger Calibration Constants</Text>

                <View style={styles.configRow}>
                  <Text style={styles.configLabel}>
                    Symbol duration: {deviceState?.settings.symbolDurationMs ?? 20} ms
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
                      <Text style={styles.stepBtnText}>-</Text>
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
                      <Text style={styles.stepBtnText}>+</Text>
                    </Pressable>
                  </View>
                </View>

                <View style={styles.configRow}>
                  <Text style={styles.configLabel}>
                    Impact threshold: {(deviceState?.settings.impactThresholdMs2 ?? 28).toFixed(0)} m/s^2
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
                      <Text style={styles.stepBtnText}>-</Text>
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
                      <Text style={styles.stepBtnText}>+</Text>
                    </Pressable>
                  </View>
                </View>

                <View style={styles.configRow}>
                  <Text style={styles.configLabel}>
                    Pocket darkness: {(deviceState?.settings.pocketLuxThreshold ?? 5).toFixed(0)} lux
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
                      <Text style={styles.stepBtnText}>-</Text>
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
                      <Text style={styles.stepBtnText}>+</Text>
                    </Pressable>
                  </View>
                </View>
              </View>

              <Pressable
                onPress={async () => {
                  await packetStore.clearPackets();
                  dedupRef.current.clear();
                  setRecords([]);
                  setSelectedPacketId(null);
                  pushBanner("Cleared local offline SOS storage and deduplication cache.");
                }}
                style={styles.clearBtn}
                accessibilityRole="button"
              >
                <Text style={styles.clearBtnText}>Clear Local Packet Cache</Text>
              </Pressable>
            </View>
          ) : null}
        </ScrollView>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: COLORS.ground,
  },
  scroll: {
    flex: 1,
  },
  container: {
    padding: 14,
    paddingBottom: 32,
    maxWidth: 920,
    width: "100%",
    alignSelf: "center",
    gap: 12,
  },
  topBar: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 10,
  },
  brandRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  brandName: {
    color: COLORS.text,
    fontSize: 20,
    fontWeight: "700",
    letterSpacing: -0.3,
  },
  offlineBadge: {
    backgroundColor: COLORS.positiveSoft,
    borderColor: COLORS.positive,
    borderWidth: 1,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 5,
  },
  offlineBadgeText: {
    color: COLORS.positive,
    fontSize: 10,
    fontWeight: "700",
  },
  runtimeSub: {
    color: COLORS.muted,
    fontSize: 11,
    marginTop: 2,
    fontVariant: ["tabular-nums"],
  },
  modeSwitch: {
    flexDirection: "row",
    backgroundColor: COLORS.surface,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: 8,
    padding: 3,
    gap: 4,
  },
  modeBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
  },
  modeBtnRadar: {
    backgroundColor: COLORS.sonarSoft,
  },
  modeBtnSos: {
    backgroundColor: COLORS.sosSoft,
  },
  modeBtnText: {
    color: COLORS.muted,
    fontSize: 12,
    fontWeight: "600",
  },
  modeBtnTextActive: {
    color: COLORS.sonar,
  },
  modeBtnTextSos: {
    color: COLORS.sos,
  },
  statusStrip: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
    gap: 8,
    backgroundColor: COLORS.surface,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  stripItem: {
    color: COLORS.muted,
    fontSize: 11,
    fontWeight: "600",
    fontVariant: ["tabular-nums"],
  },
  textSonar: { color: COLORS.sonar },
  textAmber: { color: COLORS.amber },
  textPos: { color: COLORS.positive },
  textMuted: { color: COLORS.muted },
  countdownCard: {
    backgroundColor: COLORS.sosSoft,
    borderColor: COLORS.sos,
    borderWidth: 1.5,
    borderRadius: 10,
    padding: 12,
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 10,
  },
  countdownCopy: {
    flex: 1,
    minWidth: 180,
  },
  countdownTitle: {
    color: COLORS.text,
    fontSize: 14,
    fontWeight: "700",
  },
  countdownSub: {
    color: COLORS.muted,
    fontSize: 12,
    marginTop: 2,
  },
  cancelCountdownBtn: {
    backgroundColor: COLORS.text,
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 6,
  },
  cancelCountdownText: {
    color: COLORS.ground,
    fontSize: 12,
    fontWeight: "700",
  },
  noticeRow: {
    backgroundColor: COLORS.surfaceElevated,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 10,
  },
  noticeText: {
    color: COLORS.text,
    fontSize: 12,
    flex: 1,
  },
  noticeDismiss: {
    color: COLORS.sonar,
    fontSize: 12,
    fontWeight: "600",
  },
  controlDeck: {
    gap: 8,
  },
  primarySosBtn: {
    backgroundColor: COLORS.sosFill,
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  primarySosBtnActive: {
    backgroundColor: COLORS.surfaceElevated,
    borderWidth: 2,
    borderColor: COLORS.sos,
  },
  primarySosText: {
    color: "#FFFFFF",
    fontSize: 15,
    fontWeight: "700",
    letterSpacing: 0.4,
  },
  secondaryControls: {
    flexDirection: "row",
    gap: 8,
  },
  secondaryBtn: {
    flex: 1,
    backgroundColor: COLORS.surface,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 11,
    alignItems: "center",
  },
  sirenBtnActive: {
    backgroundColor: COLORS.amberSoft,
    borderColor: COLORS.amber,
  },
  secondaryBtnText: {
    color: COLORS.text,
    fontSize: 13,
    fontWeight: "600",
  },
  sirenBtnTextActive: {
    color: COLORS.amber,
  },
  telemetryGrid: {
    flexDirection: Platform.OS === "web" ? "row" : "column",
    flexWrap: "wrap",
    gap: 12,
  },
  telemetryCol: {
    flex: 1,
    minWidth: 280,
  },
  tabBar: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
    gap: 14,
  },
  tabBtn: {
    paddingVertical: 9,
    borderBottomWidth: 2,
    borderBottomColor: "transparent",
  },
  tabBtnActive: {
    borderBottomColor: COLORS.sonar,
  },
  tabText: {
    color: COLORS.muted,
    fontSize: 13,
    fontWeight: "600",
  },
  tabTextActive: {
    color: COLORS.text,
  },
  panel: {
    gap: 10,
  },
  noteInputRow: {
    flexDirection: "row",
    gap: 6,
    alignItems: "center",
  },
  noteInput: {
    flex: 1,
    height: 36,
    backgroundColor: COLORS.surface,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 10,
    color: COLORS.text,
    fontSize: 13,
  },
  smallActionBtn: {
    height: 36,
    paddingHorizontal: 10,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.surfaceElevated,
    justifyContent: "center",
  },
  smallActionText: {
    color: COLORS.sonar,
    fontSize: 11,
    fontWeight: "600",
  },
  emptyBox: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderStyle: "dashed",
    borderRadius: 8,
    padding: 20,
    alignItems: "center",
  },
  emptyTitle: {
    color: COLORS.text,
    fontSize: 14,
    fontWeight: "600",
  },
  emptySub: {
    color: COLORS.muted,
    fontSize: 12,
    marginTop: 4,
    textAlign: "center",
  },
  hexBox: {
    backgroundColor: COLORS.surface,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: 8,
    padding: 10,
    gap: 4,
  },
  hexTitle: {
    color: COLORS.muted,
    fontSize: 11,
    fontWeight: "600",
  },
  hexBody: {
    color: COLORS.sonar,
    fontSize: 11,
    lineHeight: 17,
    fontVariant: ["tabular-nums"],
  },
  sensorGrid: {
    flexDirection: "row",
    gap: 10,
  },
  sensorTile: {
    flex: 1,
    backgroundColor: COLORS.surface,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
  },
  sensorLabel: {
    color: COLORS.muted,
    fontSize: 11,
    fontWeight: "600",
  },
  sensorValue: {
    color: COLORS.text,
    fontSize: 18,
    fontWeight: "700",
    marginTop: 4,
    fontVariant: ["tabular-nums"],
  },
  sensorSub: {
    color: COLORS.muted,
    fontSize: 11,
    marginTop: 2,
  },
  labActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  labBtn: {
    backgroundColor: COLORS.surfaceElevated,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 11,
    paddingVertical: 8,
  },
  labBtnText: {
    color: COLORS.text,
    fontSize: 12,
    fontWeight: "600",
  },
  configCard: {
    backgroundColor: COLORS.surface,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    gap: 10,
  },
  configTitle: {
    color: COLORS.text,
    fontSize: 13,
    fontWeight: "600",
  },
  configRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  configLabel: {
    color: COLORS.muted,
    fontSize: 12,
    fontVariant: ["tabular-nums"],
  },
  stepper: {
    flexDirection: "row",
    gap: 6,
  },
  stepBtn: {
    width: 30,
    height: 28,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.surfaceElevated,
    alignItems: "center",
    justifyContent: "center",
  },
  stepBtnText: {
    color: COLORS.text,
    fontSize: 14,
    fontWeight: "700",
  },
  clearBtn: {
    borderWidth: 1,
    borderColor: COLORS.sos,
    backgroundColor: COLORS.sosSoft,
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: "center",
  },
  clearBtnText: {
    color: COLORS.sos,
    fontSize: 12,
    fontWeight: "700",
  },
});
