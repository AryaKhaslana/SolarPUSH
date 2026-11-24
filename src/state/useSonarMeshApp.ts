import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import {
  INITIAL_PERMISSIONS,
  canStartMeshSafely,
  checkAllPermissions,
  hasMeshBluetoothPermission,
  listMissingCorePermissions,
  requestAllRuntimePermissions,
  requestPermission,
  requestSinglePermission,
  type PermissionKey,
  type PermissionSnapshot,
} from "@/permissions/androidPermissions";
import { getCurrentLocation } from "@/services/locationService";
import { sonarMeshBridge } from "@/native/sonarMeshBridge";

export type BootStatus = "loading" | "ready" | "error";

export function useSonarMeshApp() {
  const [bootStatus, setBootStatus] = useState<BootStatus>("loading");
  const [deviceState, setDeviceState] = useState<PersistedDeviceState | null>(null);
  const [records, setRecords] = useState<StoredSosRecord[]>([]);
  const [selectedPacketId, setSelectedPacketId] = useState<string | null>(null);

  const [permissions, setPermissions] = useState<PermissionSnapshot>(INITIAL_PERMISSIONS);
  const [requestingPerm, setRequestingPerm] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);

  const [sosActive, setSosActive] = useState(false);
  const [meshRunning, setMeshRunning] = useState(false);
  const [acousticListening, setAcousticListening] = useState(false);
  const [calibrating, setCalibrating] = useState(false);
  const [sirenActive, setSirenActive] = useState(false);

  const [spectrum, setSpectrum] = useState<NativeSpectrumFrame | null>(null);
  const [noiseFloorDb, setNoiseFloorDb] = useState(-54.0);
  const [thresholdDb, setThresholdDb] = useState(-42.5);
  const [headingDeg, setHeadingDeg] = useState(24);
  const [accelMs2, setAccelMs2] = useState(9.81);
  const [lightLux, setLightLux] = useState(140);
  const [isPocketBag, setIsPocketBag] = useState(false);
  const [batteryPct, setBatteryPct] = useState(86);

  const [shortNote, setShortNote] = useState("TERJEBAK");
  const [countdownSec, setCountdownSec] = useState<number | null>(null);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [relayedCount, setRelayedCount] = useState(0);
  const [rejectedCount, setRejectedCount] = useState(0);

  const dedupRef = useRef(new PacketDeduplicator(512, SONARMESH_CONSTANTS.DEDUP_WINDOW_MS));
  const deviceStateRef = useRef<PersistedDeviceState | null>(null);
  const sosActiveRef = useRef<boolean>(sosActive);
  const pocketRef = useRef<boolean>(isPocketBag);
  const permsRef = useRef<PermissionSnapshot>(permissions);
  const countdownRef = useRef<number | null>(countdownSec);
  const listeningRef = useRef<boolean>(acousticListening);

  deviceStateRef.current = deviceState;
  sosActiveRef.current = sosActive;
  pocketRef.current = isPocketBag;
  permsRef.current = permissions;
  countdownRef.current = countdownSec;
  listeningRef.current = acousticListening;

  const showToast = useCallback((msg: string) => {
    setToastMsg(msg);
  }, []);

  const refreshOfflineGpsFix = useCallback(async (perms: PermissionSnapshot) => {
    if (!perms.location) return;
    try {
      const current = deviceStateRef.current;
      const fix = await getCurrentLocation(
        current
          ? {
              lat: current.lastLatitude,
              lon: current.lastLongitude,
              accuracyM: current.lastAccuracyM,
            }
          : undefined
      );
      if (!fix.isFallback) {
        setDeviceState((prev) => {
          if (!prev) return prev;
          const next: PersistedDeviceState = {
            ...prev,
            lastLatitude: fix.lat,
            lastLongitude: fix.lon,
            lastAccuracyM: fix.accuracyM,
          };
          deviceStateRef.current = next;
          void packetStore.saveDeviceState(next);
          return next;
        });
      }
    } catch {
      // Offline / no cached GPS fix yet: keep persisted coordinates safely.
    }
  }, []);

  const ensureMeshStartedIfPermitted = useCallback(
    async (
      mode: "RADAR" | "SOS",
      lowLatency: boolean,
      perms: PermissionSnapshot,
      settings: SonarMeshSettings
    ): Promise<boolean> => {
      if (!canStartMeshSafely(perms)) {
        setMeshRunning(false);
        return false;
      }
      const started = await sonarMeshBridge.startMesh(mode, lowLatency, settings);
      setMeshRunning(started);
      return started;
    },
    []
  );

  const dispatchSosPacket = useCallback(
    async (
      triggerType: TriggerType,
      options?: { sirenReq?: boolean; playAcoustic?: boolean }
    ) => {
      const st = deviceStateRef.current;
      if (!st) return;

      const nextSeq = (st.seqCounter + 1) & 0xffff;
      const updatedState: PersistedDeviceState = { ...st, seqCounter: nextSeq };
      deviceStateRef.current = updatedState;
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

      const canBle = hasMeshBluetoothPermission(permsRef.current);
      let bleOk = false;
      let acousticOk = false;

      if (canBle) {
        bleOk = await sonarMeshBridge.broadcastBle(raw56, 4000);
      }
      if (options?.playAcoustic) {
        acousticOk = await sonarMeshBridge.transmitUltrasonic(raw56);
      }

      if (!canBle && !options?.playAcoustic) {
        showToast("Paket SOS tersimpan lokal. Aktifkan izin Bluetooth untuk siaran BLE.");
      } else if (options?.playAcoustic && !acousticOk) {
        // Bridge already reported native error via onError callback.
      } else if (canBle && !bleOk) {
        // Bridge already reported native error via onError callback.
      } else {
        showToast(
          options?.playAcoustic
            ? "Sinyal SOS terkirim lewat Bluetooth & gelombang suara 19 kHz."
            : "Sinyal SOS disiarkan lewat Bluetooth offline."
        );
      }
    },
    [batteryPct, shortNote, showToast]
  );

  // Safe startup bootstrap: never invokes ForegroundService or mic before onboarding & permissions
  useEffect(() => {
    let active = true;

    async function boot() {
      try {
        const [st, savedPackets, perms, telemetry] = await Promise.all([
          packetStore.loadDeviceState(),
          packetStore.loadPackets(100),
          checkAllPermissions().catch(() => INITIAL_PERMISSIONS),
          sonarMeshBridge.getDeviceTelemetry().catch(() => ({
            batteryPct: 86,
            airplaneMode: false,
            serviceRunning: false,
            relayedCount: 0,
            acousticListening: false,
            sirenPlaying: false,
          })),
        ]);
        if (!active) return;

        deviceStateRef.current = st;
        permsRef.current = perms;
        setDeviceState(st);
        setRecords(savedPackets);
        setPermissions(perms);
        setBatteryPct(telemetry.batteryPct);
        setRelayedCount(telemetry.relayedCount);
        setShowOnboarding(!st.onboardingCompleted);

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
            try {
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
                void sonarMeshBridge.startSiren().then((started) => {
                  if (started) {
                    setSirenActive(true);
                    showToast("Penolong terdeteksi dekat. Sirene 3,5 kHz dinyalakan.");
                  }
                });
              }
            } catch {
              setRejectedCount((c) => c + 1);
            }
          },
          onSpectrum: (frame) => setSpectrum(frame),
          onCalibration: (res) => {
            setCalibrating(false);
            setNoiseFloorDb(res.noiseFloorDb);
            setThresholdDb(res.thresholdDb);
            showToast(`Kalibrasi selesai (ambang ${res.thresholdDb.toFixed(1)} dB).`);
          },
          onImpact: (ev) => {
            if (countdownRef.current !== null) return;
            const sec =
              deviceStateRef.current?.settings.sosCountdownSec ??
              DEFAULT_SONARMESH_SETTINGS.sosCountdownSec;
            countdownRef.current = sec;
            setCountdownSec(sec);
            showToast(
              `Benturan keras terdeteksi (${ev.magnitudeMs2.toFixed(1)} m/s^2). Batalkan dalam ${sec} detik.`
            );
          },
          onSensors: (snap) => {
            pocketRef.current = snap.isPocketBag;
            setAccelMs2(snap.accelMagnitudeMs2);
            setLightLux(snap.lightLux);
            setIsPocketBag(snap.isPocketBag);
            setHeadingDeg(snap.headingDeg);
          },
          onError: (msg) => showToast(msg),
        });

        // Only auto-start mesh service after onboarding AND when required permissions are granted
        if (st.onboardingCompleted && canStartMeshSafely(perms)) {
          await ensureMeshStartedIfPermitted("RADAR", false, perms, st.settings);
          void refreshOfflineGpsFix(perms);
        }

        if (active) setBootStatus("ready");
      } catch (err) {
        console.warn("[SonarMesh Boot]", err);
        if (active) setBootStatus("error");
      }
    }

    void boot();
    return () => {
      active = false;
      sonarMeshBridge.detach();
    };
  }, [ensureMeshStartedIfPermitted, refreshOfflineGpsFix, showToast]);

  const countdownActive = countdownSec !== null;
  useEffect(() => {
    if (!countdownActive) return;
    const interval = setInterval(() => {
      const current = countdownRef.current;
      if (current === null) return;
      const next = current - 1;
      if (next <= 0) {
        clearInterval(interval);
        countdownRef.current = null;
        setCountdownSec(null);
        sosActiveRef.current = true;
        setSosActive(true);
        void dispatchSosPacket("SENSOR_SOS", { sirenReq: pocketRef.current, playAcoustic: true });
      } else {
        countdownRef.current = next;
        setCountdownSec(next);
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [countdownActive, dispatchSosPacket]);

  const handleRequestSinglePermission = useCallback(
    async (key: PermissionKey) => {
      setRequestingPerm(true);
      try {
        await requestSinglePermission(key);
        const refreshed = await checkAllPermissions();
        permsRef.current = refreshed;
        setPermissions(refreshed);
        const st = deviceStateRef.current;
        if (st && st.onboardingCompleted && canStartMeshSafely(refreshed)) {
          await ensureMeshStartedIfPermitted(
            sosActiveRef.current ? "SOS" : "RADAR",
            sosActiveRef.current,
            refreshed,
            st.settings
          );
          void refreshOfflineGpsFix(refreshed);
        }
      } finally {
        setRequestingPerm(false);
      }
    },
    [ensureMeshStartedIfPermitted, refreshOfflineGpsFix]
  );

  const completeOnboardingWithPerms = useCallback(
    async (perms: PermissionSnapshot) => {
      permsRef.current = perms;
      setPermissions(perms);
      await packetStore.setOnboardingCompleted(true);
      setDeviceState((prev) => {
        const next = prev ? { ...prev, onboardingCompleted: true } : prev;
        deviceStateRef.current = next;
        return next;
      });
      setShowOnboarding(false);

      const st = deviceStateRef.current;
      if (st && canStartMeshSafely(perms)) {
        await ensureMeshStartedIfPermitted("RADAR", false, perms, st.settings);
        void refreshOfflineGpsFix(perms);
      }
    },
    [ensureMeshStartedIfPermitted, refreshOfflineGpsFix]
  );

  const handleRequestAllAndFinish = useCallback(async () => {
    setRequestingPerm(true);
    try {
      const updated = await requestAllRuntimePermissions();
      await completeOnboardingWithPerms(updated);
    } finally {
      setRequestingPerm(false);
    }
  }, [completeOnboardingWithPerms]);

  const handleSkipOnboarding = useCallback(async () => {
    const current = await checkAllPermissions();
    await completeOnboardingWithPerms(current);
  }, [completeOnboardingWithPerms]);

  const toggleSos = useCallback(async () => {
    const st = deviceStateRef.current;
    if (!st) return;
    if (sosActiveRef.current) {
      sosActiveRef.current = false;
      setSosActive(false);
      if (canStartMeshSafely(permsRef.current)) {
        await ensureMeshStartedIfPermitted("RADAR", false, permsRef.current, st.settings);
      }
      showToast("Siaran SOS dihentikan. Kembali ke mode siaga.");
    } else {
      sosActiveRef.current = true;
      setSosActive(true);
      if (canStartMeshSafely(permsRef.current)) {
        await ensureMeshStartedIfPermitted("SOS", true, permsRef.current, st.settings);
      }
      await dispatchSosPacket("MANUAL", { sirenReq: false, playAcoustic: true });
    }
  }, [dispatchSosPacket, ensureMeshStartedIfPermitted, showToast]);

  const sendUltrasonicPing = useCallback(async () => {
    await dispatchSosPacket("MANUAL", { playAcoustic: true, sirenReq: false });
  }, [dispatchSosPacket]);

  const toggleAcousticListen = useCallback(async () => {
    const st = deviceStateRef.current;
    if (!st) return;
    if (listeningRef.current) {
      await sonarMeshBridge.stopAcousticListen();
      listeningRef.current = false;
      setAcousticListening(false);
      showToast("Mikrofon dimatikan agar baterai hemat.");
      return;
    }

    if (!permsRef.current.microphone) {
      const status = await requestPermission("microphone");
      const refreshed = await checkAllPermissions();
      permsRef.current = refreshed;
      setPermissions(refreshed);
      if (status !== "granted") {
        showToast("Izin mikrofon ditolak. Aktifkan izin di Pengaturan untuk mendengar sinyal suara.");
        return;
      }
    }

    const ok = await sonarMeshBridge.startAcousticListen(st.settings);
    listeningRef.current = ok;
    setAcousticListening(ok);
    if (ok) {
      showToast("Mendengarkan sinyal ultrasonik 18,5-20 kHz...");
    }
  }, [showToast]);

  const calibrateNoiseFloor = useCallback(async () => {
    const st = deviceStateRef.current;
    if (!st) return;
    if (!permsRef.current.microphone) {
      const status = await requestPermission("microphone");
      const refreshed = await checkAllPermissions();
      permsRef.current = refreshed;
      setPermissions(refreshed);
      if (status !== "granted") {
        showToast("Izin mikrofon diperlukan untuk kalibrasi ruangan 3 detik.");
        return;
      }
    }
    if (!listeningRef.current) {
      const ok = await sonarMeshBridge.startAcousticListen(st.settings);
      listeningRef.current = ok;
      setAcousticListening(ok);
      if (!ok) return;
    }
    setCalibrating(true);
    showToast("Harap tenang 3 detik untuk mengukur kebisingan ruangan...");
    const started = await sonarMeshBridge.calibrateNoiseFloor(
      SONARMESH_CONSTANTS.CALIBRATION_DURATION_MS
    );
    if (!started) {
      setCalibrating(false);
    }
  }, [showToast]);

  const toggleSiren = useCallback(async () => {
    if (sirenActive) {
      await sonarMeshBridge.stopSiren();
      setSirenActive(false);
      showToast("Sirene 3,5 kHz dimatikan.");
    } else {
      const started = await sonarMeshBridge.startSiren();
      setSirenActive(started);
      if (started) {
        showToast("Sirene darurat 3,5 kHz berbunyi.");
      }
    }
  }, [showToast, sirenActive]);

  const cancelSosCountdown = useCallback(() => {
    countdownRef.current = null;
    setCountdownSec(null);
    showToast("Pengiriman SOS otomatis dibatalkan.");
  }, [showToast]);

  const updateSettings = useCallback(async (partial: Partial<SonarMeshSettings>) => {
    const current = deviceStateRef.current;
    if (!current) return;
    const next: PersistedDeviceState = {
      ...current,
      settings: { ...current.settings, ...partial },
    };
    deviceStateRef.current = next;
    setDeviceState(next);
    await packetStore.saveDeviceState(next);
    await sonarMeshBridge.updateSensorConfig(next.settings);
  }, []);

  const updateSetting = useCallback(
    <K extends keyof SonarMeshSettings>(key: K, value: SonarMeshSettings[K]) => {
      void updateSettings({ [key]: value } as Partial<SonarMeshSettings>);
    },
    [updateSettings]
  );

  const clearHistory = useCallback(async () => {
    await packetStore.clearPackets();
    dedupRef.current.clear();
    setRecords([]);
    setSelectedPacketId(null);
    showToast("Riwayat paket lokal dibersihkan.");
  }, [showToast]);

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

  const missingPerms = useMemo(
    () => listMissingCorePermissions(permissions),
    [permissions]
  );

  return {
    bootStatus,
    booting: bootStatus === "loading",
    onboardingCompleted: deviceState?.onboardingCompleted ?? false,
    showOnboarding,
    setShowOnboarding,
    deviceState,
    records,
    packets: records,
    selectedPacketId,
    setSelectedPacketId,
    selectedRecord,
    selectedHex,
    permissions,
    missingPerms,
    requestingPerm,
    sosActive,
    meshRunning,
    meshActive: meshRunning,
    acousticListening,
    listening: acousticListening,
    calibrating,
    sirenActive,
    spectrum,
    noiseFloorDb,
    thresholdDb,
    headingDeg,
    accelMs2,
    lightLux,
    isPocketBag,
    batteryPct,
    shortNote,
    setShortNote,
    countdownSec,
    toastMsg,
    setToastMsg,
    relayedCount,
    rejectedCount,
    dispatchSosPacket,
    handleRequestSinglePermission,
    handleRequestAllAndFinish,
    handleSkipOnboarding,
    toggleSos,
    sendUltrasonicPing,
    toggleAcousticListen,
    calibrateNoiseFloor,
    toggleSiren,
    cancelSosCountdown,
    updateSettings,
    updateSetting,
    clearHistory,
  };
}

export default useSonarMeshApp;
