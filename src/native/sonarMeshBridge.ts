import {
  SonarMeshNative,
  createNativeEventEmitter,
  isNativeAndroidModuleAvailable,
  type NativeCalibrationResult,
  type NativeImpactEvent,
  type NativePacketEvent,
  type NativeSensorTelemetry,
  type NativeSpectrumFrame,
} from "sonarmesh-native";
import {
  SONARMESH_CONSTANTS,
  type SonarMeshSettings,
} from "@/config/sonarmeshConfig";
import {
  base64ToBytes,
  bytesToBase64,
  encodeSmpV1,
  randomHex,
  type SmpV1Packet,
} from "@/protocol/smpv1";

export type BridgeCallbacks = {
  onPacket: (ev: NativePacketEvent) => void;
  onSpectrum: (frame: NativeSpectrumFrame) => void;
  onCalibration: (res: NativeCalibrationResult) => void;
  onImpact: (ev: NativeImpactEvent) => void;
  onSensors: (snap: NativeSensorTelemetry) => void;
  onError: (msg: string) => void;
};

/**
 * Platform-aware hardware bridge:
 * - On Android Development Build: delegates directly to Kotlin SonarMeshNativeModule.
 * - On Web / Expo Go preview: executes real SMPv1 56B binary loopback, live simulated
 *   18.2-20.2 kHz FFT bins, Web Audio API 3.5 kHz siren, and interactive sensor simulation.
 */
export class SonarMeshBridge {
  private readonly isNative = isNativeAndroidModuleAvailable && SonarMeshNative !== null;
  private subs: Array<{ remove: () => void }> = [];
  private cb: BridgeCallbacks | null = null;

  // Web / software fallback state
  private simSpectrumTimer: ReturnType<typeof setInterval> | null = null;
  private simAudioCtx: AudioContext | null = null;
  private simSirenOsc: OscillatorNode | null = null;
  private simSirenGain: GainNode | null = null;
  private simSirenPulseTimer: ReturnType<typeof setInterval> | null = null;
  private simNoiseFloorDb = -54.0;
  private simHeading = 24;
  private simLightLux = 140;
  private simPocketBag = false;
  private simAccelMs2 = 9.81;
  private simActiveTxUntilMs = 0;
  private simSettings: SonarMeshSettings | null = null;

  get runtimeLabel(): string {
    return this.isNative ? "Android Native Kotlin" : "Software Loopback (Preview)";
  }

  get nativeAvailable(): boolean {
    return this.isNative;
  }

  attach(callbacks: BridgeCallbacks) {
    this.detach();
    this.cb = callbacks;

    if (this.isNative) {
      const emitter = createNativeEventEmitter();
      if (!emitter) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const em = emitter as any;
      this.subs = [
        em.addListener("onPacketReceived", (ev: NativePacketEvent) => callbacks.onPacket(ev)),
        em.addListener("onSpectrumFrame", (frame: NativeSpectrumFrame) => callbacks.onSpectrum(frame)),
        em.addListener("onCalibrationResult", (res: NativeCalibrationResult) => callbacks.onCalibration(res)),
        em.addListener("onImpactDetected", (ev: NativeImpactEvent) => callbacks.onImpact(ev)),
        em.addListener("onSensorTelemetry", (snap: NativeSensorTelemetry) => callbacks.onSensors(snap)),
        em.addListener("onNativeError", (e: { message?: string }) =>
          callbacks.onError(e?.message || "Native hardware error")
        ),
      ];
    }
  }

  detach() {
    for (const s of this.subs) {
      try {
        s.remove();
      } catch {
        // Ignore cleanup errors.
      }
    }
    this.subs = [];
    this.stopSimSpectrum();
    this.stopSimSiren();
    this.cb = null;
  }

  async startMesh(mode: "RADAR" | "SOS", lowLatency: boolean, settings: SonarMeshSettings) {
    this.simSettings = settings;
    if (this.isNative && SonarMeshNative) {
      await SonarMeshNative.updateSensorConfig(
        settings.impactThresholdMs2,
        settings.pocketLuxThreshold
      );
      await SonarMeshNative.startMeshService(mode, lowLatency);
      return;
    }
    this.cb?.onSensors({
      accelMagnitudeMs2: this.simAccelMs2,
      lightLux: this.simLightLux,
      isPocketBag: this.simPocketBag,
      headingDeg: this.simHeading,
    });
  }

  async stopMesh() {
    if (this.isNative && SonarMeshNative) {
      await SonarMeshNative.stopMeshService();
      return;
    }
    this.stopSimSpectrum();
    this.stopSimSiren();
  }

  async startAcousticListen(settings: SonarMeshSettings) {
    this.simSettings = settings;
    if (this.isNative && SonarMeshNative) {
      await SonarMeshNative.startAcousticListen(
        settings.freqSpace0Hz,
        settings.freqMark1Hz,
        settings.symbolDurationMs
      );
      return;
    }
    this.startSimSpectrum(settings);
  }

  async stopAcousticListen() {
    if (this.isNative && SonarMeshNative) {
      await SonarMeshNative.stopAcousticListen();
      return;
    }
    this.stopSimSpectrum();
  }

  async calibrateNoiseFloor(durationMs = SONARMESH_CONSTANTS.CALIBRATION_DURATION_MS) {
    if (this.isNative && SonarMeshNative) {
      await SonarMeshNative.calibrateNoiseFloor(durationMs);
      return;
    }
    setTimeout(() => {
      const floor = Math.round((-56 + Math.random() * 6) * 10) / 10;
      this.simNoiseFloorDb = floor;
      this.cb?.onCalibration({
        noiseFloorDb: floor,
        thresholdDb: Math.round((floor + 11.5) * 10) / 10,
      });
    }, durationMs);
  }

  async transmitUltrasonic(raw56: Uint8Array): Promise<void> {
    const b64 = bytesToBase64(raw56);
    if (this.isNative && SonarMeshNative) {
      await SonarMeshNative.transmitUltrasonic(b64);
      return;
    }
    this.simActiveTxUntilMs = Date.now() + 2600;
    this.playWebUltrasonicPreview();
  }

  async broadcastBle(raw56: Uint8Array, durationMs = 3500): Promise<void> {
    const b64 = bytesToBase64(raw56);
    if (this.isNative && SonarMeshNative) {
      await SonarMeshNative.broadcastBlePacket(b64, durationMs);
      return;
    }
    // Software preview mode: no external BLE radio.
  }

  async startSiren(): Promise<void> {
    if (this.isNative && SonarMeshNative) {
      await SonarMeshNative.startSiren();
      return;
    }
    this.startSimSiren();
  }

  async stopSiren(): Promise<void> {
    if (this.isNative && SonarMeshNative) {
      await SonarMeshNative.stopSiren();
      return;
    }
    this.stopSimSiren();
  }

  async updateSensorConfig(settings: SonarMeshSettings): Promise<void> {
    this.simSettings = settings;
    if (this.isNative && SonarMeshNative) {
      await SonarMeshNative.updateSensorConfig(
        settings.impactThresholdMs2,
        settings.pocketLuxThreshold
      );
    }
  }

  async requestIgnoreBatteryOptimizations(): Promise<boolean> {
    if (this.isNative && SonarMeshNative) {
      const res = await SonarMeshNative.requestIgnoreBatteryOptimizations();
      return res.ignoring;
    }
    return true;
  }

  // Interactive test helpers (also usable on Android for field bench testing)
  simulateImpactShock(magnitudeMs2 = 34.5) {
    this.simAccelMs2 = magnitudeMs2;
    this.cb?.onSensors({
      accelMagnitudeMs2: magnitudeMs2,
      lightLux: this.simLightLux,
      isPocketBag: this.simPocketBag,
      headingDeg: this.simHeading,
    });
    this.cb?.onImpact({ magnitudeMs2, isPocketBag: this.simPocketBag });
    setTimeout(() => {
      this.simAccelMs2 = 9.81;
      this.cb?.onSensors({
        accelMagnitudeMs2: 9.81,
        lightLux: this.simLightLux,
        isPocketBag: this.simPocketBag,
        headingDeg: this.simHeading,
      });
    }, 900);
  }

  simulatePocketToggle(pocketDark: boolean) {
    this.simPocketBag = pocketDark;
    this.simLightLux = pocketDark ? 1.2 : 185.0;
    this.cb?.onSensors({
      accelMagnitudeMs2: this.simAccelMs2,
      lightLux: this.simLightLux,
      isPocketBag: this.simPocketBag,
      headingDeg: this.simHeading,
    });
  }

  simulateCompassShift(deltaDeg: number) {
    this.simHeading = (this.simHeading + deltaDeg + 360) % 360;
    this.cb?.onSensors({
      accelMagnitudeMs2: this.simAccelMs2,
      lightLux: this.simLightLux,
      isPocketBag: this.simPocketBag,
      headingDeg: this.simHeading,
    });
  }

  /** Injects a real CRC-valid 56-byte SMPv1 packet through the exact same inbound decode pipeline. */
  injectSimulatedInboundPacket(
    baseLat: number,
    baseLon: number,
    transport: "ble" | "ultrasonic",
    overrides: Partial<SmpV1Packet> = {}
  ) {
    const offsetLat = (Math.random() - 0.5) * 0.00055;
    const offsetLon = (Math.random() - 0.5) * 0.00055;
    const pkt: SmpV1Packet = {
      triggerType: transport === "ultrasonic" ? "MANUAL" : "SENSOR_SOS",
      envPocketBag: transport === "ble" ? Math.random() > 0.45 : false,
      sirenReq: overrides.sirenReq ?? false,
      ttl: overrides.ttl ?? 3,
      packetId: randomHex(8),
      seqCounter: Math.floor(1 + Math.random() * 400),
      latitude: baseLat + offsetLat,
      longitude: baseLon + offsetLon,
      gpsAccBucket: 2,
      batteryQuant: Math.floor(3 + Math.random() * 11),
      ageSec: Math.floor(2 + Math.random() * 45),
      senderHint: overrides.senderHint ?? randomHex(4),
      powNonce: Math.floor(Math.random() * 1024),
      shortPayload:
        overrides.shortPayload ??
        (transport === "ultrasonic" ? "FL2 STAIR" : "SOS BAG!"),
      ...overrides,
    };
    const raw56 = encodeSmpV1(pkt);
    if (transport === "ultrasonic") {
      this.simActiveTxUntilMs = Date.now() + 1800;
    }
    this.cb?.onPacket({
      packetBase64: bytesToBase64(raw56),
      transport,
      rssi: transport === "ultrasonic" ? -54 : Math.round(-56 - Math.random() * 34),
      relayed: pkt.ttl > 1,
      snrDb: transport === "ultrasonic" ? Math.round((14 + Math.random() * 9) * 10) / 10 : 0,
    });
  }

  private startSimSpectrum(settings: SonarMeshSettings) {
    this.stopSimSpectrum();
    const startHz = 18200;
    const endHz = 20200;
    const binCount = 40;
    const stepHz = (endHz - startHz) / (binCount - 1);

    this.simSpectrumTimer = setInterval(() => {
      const txActive = Date.now() < this.simActiveTxUntilMs;
      const activeFreq =
        Math.random() > 0.5 ? settings.freqMark1Hz : settings.freqSpace0Hz;
      const binsDb: number[] = [];
      let peakDb = -90;
      let peakFreq = startHz;

      for (let i = 0; i < binCount; i++) {
        const f = startHz + i * stepHz;
        let db = this.simNoiseFloorDb + (Math.random() - 0.5) * 6.5;
        if (txActive) {
          const dist = Math.abs(f - activeFreq);
          if (dist < 140) {
            db += (1 - dist / 140) * 28;
          }
        }
        const rounded = Math.round(db * 10) / 10;
        binsDb.push(rounded);
        if (rounded > peakDb) {
          peakDb = rounded;
          peakFreq = Math.round(f);
        }
      }

      this.cb?.onSpectrum({
        startFreqHz: startHz,
        endFreqHz: endHz,
        binsDb,
        peakFreqHz: peakFreq,
        noiseFloorDb: this.simNoiseFloorDb,
        snrDb: Math.round((peakDb - this.simNoiseFloorDb) * 10) / 10,
      });
    }, 95);
  }

  private stopSimSpectrum() {
    if (this.simSpectrumTimer) {
      clearInterval(this.simSpectrumTimer);
      this.simSpectrumTimer = null;
    }
  }

  private playWebUltrasonicPreview() {
    if (typeof window === "undefined") return;
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    try {
      const ctx = this.simAudioCtx ?? new AudioCtx();
      this.simAudioCtx = ctx;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      const s0 = this.simSettings?.freqSpace0Hz ?? 18750;
      const s1 = this.simSettings?.freqMark1Hz ?? 19500;
      osc.frequency.setValueAtTime(s0, ctx.currentTime);
      osc.frequency.setValueAtTime(s1, ctx.currentTime + 0.12);
      osc.frequency.setValueAtTime(s0, ctx.currentTime + 0.24);
      gain.gain.setValueAtTime(0.08, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.45);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.46);
    } catch {
      // Browser autoplay policy may block audio before user gesture.
    }
  }

  private startSimSiren() {
    if (typeof window === "undefined") return;
    this.stopSimSiren();
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    try {
      const ctx = this.simAudioCtx ?? new AudioCtx();
      this.simAudioCtx = ctx;
      if (ctx.state === "suspended") void ctx.resume();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(SONARMESH_CONSTANTS.SIREN_FREQ_HZ, ctx.currentTime);
      gain.gain.setValueAtTime(0.14, ctx.currentTime);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();

      let on = true;
      this.simSirenOsc = osc;
      this.simSirenGain = gain;
      this.simSirenPulseTimer = setInterval(() => {
        on = !on;
        gain.gain.setTargetAtTime(on ? 0.14 : 0.001, ctx.currentTime, 0.015);
        osc.frequency.setTargetAtTime(on ? 3540 : 3460, ctx.currentTime, 0.04);
      }, 420);
    } catch {
      // Ignore audio errors.
    }
  }

  private stopSimSiren() {
    if (this.simSirenPulseTimer) {
      clearInterval(this.simSirenPulseTimer);
      this.simSirenPulseTimer = null;
    }
    try {
      this.simSirenOsc?.stop();
      this.simSirenOsc?.disconnect();
      this.simSirenGain?.disconnect();
    } catch {
      // Ignore stop errors.
    }
    this.simSirenOsc = null;
    this.simSirenGain = null;
  }

  static decodeEventBytes(b64: string): Uint8Array {
    return base64ToBytes(b64);
  }
}

export const sonarMeshBridge = new SonarMeshBridge();
