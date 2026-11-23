# PRD: SonarMesh (Offline P2P Disaster & SOS Communication App — Software-Only MVP)
**Recommended Filename:** `tasks/prd-sonarmesh.md`

---

### 1. Introduction/Overview
**SonarMesh** adalah aplikasi komunikasi darurat, radar pencari korban, dan pesan P2P *offline* (100% tanpa internet, jaringan seluler, maupun *hardware* tambahan) yang berjalan di perangkat Android standar. Aplikasi ini dirancang sebagai proyek simpenan pribadi yang menggabungkan *near-ultrasonic acoustic signaling* (18,5–20 kHz) dan *Bluetooth Low Energy* (BLE) dengan protokol biner ringkas (`SMPv1` — 56 byte) agar perangkat tetap dapat saling mendeteksi dan meneruskan sinyal SOS saat infrastruktur jaringan lumpuh.

### 2. Goals
- **GM-1 (Zero-Network Operation):** Mengirim, menerima, dan meneruskan paket darurat `SMPv1` (56 byte) antar-perangkat Android dalam *Airplane Mode* penuh tanpa koneksi internet.
- **GM-2 (Hybrid Acoustic + BLE Transport):** Mengirim dan membaca data biner melalui gelombang suara *near-ultrasonic* (18,5–20 kHz) menggunakan `AudioTrack` dan `AudioRecord` (48 kHz) serta menyebarkannya via *BLE Advertising/Scanning* dengan *Packet Deduplication* dan `TTL` agar tidak terjadi *broadcast storm*.
- **GM-3 (Multi-Trigger & Pocket-Aware SOS):** Memicu status SOS melalui tombol manual di layar, deteksi guncangan ekstrem *Accelerometer*, serta deteksi ruang gelap/tertutup via *Light Sensor* (saku/tas), dilengkapi mode *sirene 3,5 kHz* saat penolong mendekat.
- **GM-4 (Unified Situational UI):** Menyediakan antarmuka terpadu pada React Native / Expo Development Build yang menggabungkan **Radar Kompas Relatif + Live FFT Spectrum** serta **Tampilan Koordinat Offline & Daftar Paket SOS**.
- **GM-5 (Personal Portfolio Readiness):** Menghasilkan *codebase* modular yang rapi, terstruktur, dan terdokumentasi dengan baik sebagai proyek simpenan pribadi.

### 3. User Stories

#### US-001: Skema Protokol Biner `SMPv1` & Penyimpanan Paket Lokal
**Description:** As a developer/user, I want a 56-byte binary packet serializer/deserializer (`SMPv1`) with CRC-16 validation and local SQLite/storage deduplication so that packets stay compact, tamper-evident, and free from duplicate re-broadcasts.

**Acceptance Criteria:**
- [ ] `SMPv1` packet layout encodes and decodes exact 56 bytes in *Big-Endian* byte order (`MAGIC_VER` `0x51`, `FLAGS_TTL`, 8-byte `PACKET_ID`, 2-byte `SEQ_COUNTER`, 4-byte `LATITUDE`, 4-byte `LONGITUDE`, 1-byte `GPS_ACC_BATT`, 2-byte `AGE_SEC`, 4-byte `SENDER_HINT`, 2-byte `POW_NONCE`, 9-byte `SHORT_PAYLOAD`, 16-byte `AUTH_SIG_128`, and 2-byte `CRC16` CCITT-FALSE).
- [ ] Packets failing `MAGIC_VER` or `CRC16` checks are rejected before persistence or relay.
- [ ] Duplicate `PACKET_ID` entries within the active cache window are ignored and not re-queued for relay.
- [ ] Typecheck/lint passes.

#### US-002: Native Module Modem Ultrasonik FSK (`AudioTrack` & `AudioRecord`)
**Description:** As a user in a no-network area, I want my Android phone to modulate 56-byte packets (plus 4-byte framing header `0xAA 0xAA 0x2D 0xD4`) into 18.5–20 kHz ultrasonic FSK audio and demodulate incoming ultrasonic signals back into binary bytes so that data transfers purely via speaker and microphone.

**Acceptance Criteria:**
- [ ] Kotlin native module transmits framing header + 56-byte payload using `AudioTrack` at 48 kHz sample rate within the 18.5–20 kHz band with media volume set to maximum during active transmission.
- [ ] Kotlin native module captures audio via `AudioRecord` at 48 kHz using FFT bin detection and locks onto the `0x2DD4` sync word to reconstruct the 56-byte payload.
- [ ] Receiver supports a 3-second room noise-floor calibration step to adjust detection threshold against ambient noise.
- [ ] Typecheck/lint passes.

#### US-003: Native Module BLE Relay & Background *ForegroundService*
**Description:** As a user moving through an affected area, I want my phone to run a resilient `ForegroundService` (`connectedDevice`) with hardware-filtered BLE scanning and beacon relaying so that SOS packets hop across nearby devices even when the screen is off.

**Acceptance Criteria:**
- [ ] `ForegroundService` (`connectedDevice`) displays a persistent status notification and requests `IGNORE_BATTERY_OPTIMIZATIONS` during onboarding.
- [ ] BLE scanner applies a `ScanFilter` matching the SonarMesh Service UUID with `PendingIntent` / low-power settings and decrements `TTL` (`TTL - 1`) with random jitter backoff (200–2000 ms) before relaying valid non-duplicate packets.
- [ ] When `TTL` reaches `0`, the packet is stored locally for display but no longer relayed.
- [ ] Typecheck/lint passes.

#### US-004: Multi-Trigger SOS Engine, Pocket Detection & Sirene 3,5 kHz
**Description:** As a user who may drop my phone or have it inside a pocket or bag, I want SOS to trigger manually or automatically from severe impact/motion and pocket/darkness context, and emit a 3.5 kHz siren when needed so that rescuers can locate the device physically.

**Acceptance Criteria:**
- [ ] SOS can be triggered via an explicit on-screen SOS button or via `Accelerometer` spike/impact detection with a configurable countdown cancellation window.
- [ ] `Light Sensor` (lux threshold) detects dark/enclosed conditions (pocket or bag) and sets `ENV_STATE` in the outbound `SMPv1` packet.
- [ ] When a packet or local command requests siren (`SIREN_REQ = 1`) or when pocketed SOS detects a nearby responder signal, the device plays a 3.5 kHz audible siren via `AudioTrack` with a clear stop control.
- [ ] Typecheck/lint passes.

#### US-005: Unified React Native UI (Radar Kompas + Spektrum Audio & Peta/Daftar SOS)
**Description:** As a user searching for or monitoring SOS signals offline, I want a single unified React Native interface combining a relative compass radar, real-time 19 kHz FFT spectrum view, and an offline coordinate/SOS packet list so that I can see signal direction, audio activity, and received alerts in one place.

**Acceptance Criteria:**
- [ ] Unified screen renders: (a) Relative Compass Radar showing direction/bearing and distance estimate from RSSI/signal strength, (b) Real-time FFT spectrum bar/line visualization around 18.5–20 kHz, and (c) Offline coordinate & SOS packet feed/map view with last-known lat/lon, accuracy, battery level, trigger type, and age in seconds.
- [ ] Users can switch between *Beacon / SOS Mode* and *Radar / Monitor Mode*, trigger 3-second noise calibration, and toggle/stop the 3.5 kHz siren.
- [ ] Typecheck/lint passes.
- [ ] Verify in browser / Android device build.

### 4. Functional Requirements
- **FR-1:** The system must serialize and deserialize 56-byte `SMPv1` binary packets in *Big-Endian* order and validate packet integrity using `MAGIC_VER` (`0x51`) and `CRC16` CCITT-FALSE (`0x1021` polynomial, `0xFFFF` init).
- **FR-2:** The system must deduplicate incoming packets using the 8-byte `PACKET_ID` and track per-sender sequence counters (`SEQ_COUNTER`) to drop exact duplicates and stale replay packets.
- **FR-3:** When relaying a packet via BLE, the system must decrement `TTL` by `1` (dropping packets with `TTL <= 0`), increment `AGE_SEC` based on elapsed local time, and wait a randomized backoff interval between 200 ms and 2000 ms before re-transmitting.
- **FR-4:** The Kotlin ultrasonic modem must frame outbound packets with preamble (`0xAA 0xAA`) and sync word (`0x2D 0xD4`) and modulate bits using FSK tones within 18.5–20 kHz via `AudioTrack`.
- **FR-5:** The Kotlin ultrasonic receiver must sample audio at 48 kHz via `AudioRecord`, run FFT analysis across the 18.5–20 kHz target bins, support a 3-second ambient noise-floor calibration routine, and emit decoded 56-byte frames to the React Native layer.
- **FR-6:** The system must run a `ForegroundService` (`connectedDevice`) for BLE and sensor monitoring, and keep microphone listening (`AudioRecord`) on-demand (activated during Radar/Monitor sessions or triggered windows rather than running unconditionally at all times).
- **FR-7:** The SOS trigger engine must support manual SOS activation, `Accelerometer` motion/impact threshold detection with a countdown cancel option, and `Light Sensor` darkness detection (`ENV_STATE` for pocket/bag).
- **FR-8:** The audio alert engine must generate a 3.5 kHz audible siren tone via `AudioTrack` when `SIREN_REQ` is active or when triggered by the user/responder proximity logic, and allow immediate silencing from the UI.
- **FR-9:** The React Native UI must combine the **Relative Compass Radar + Live 18.5–20 kHz FFT Spectrum** and the **Offline Coordinate View + Received SOS Packet List** in a unified layout accessible without internet connectivity.
- **FR-10:** The app must persist received SOS events, last-known GPS coordinates, and basic configuration locally on-device (offline storage) across app restarts.

### 5. Non-Goals (Out of Scope)
- **No iOS / Swift Implementation:** MVP targets Android only; iOS background BLE advertising restrictions are out of scope.
- **No External Hardware / LoRa / Mesh Radios:** Pure software-only implementation using built-in phone sensors, speaker, microphone, and BLE.
- **No Online Map Tiles or Cloud Backend:** No paid map SDKs requiring live internet, no BPBD/BASARNAS server integration, and no cloud user accounts/login.
- **No Barometer Pressure-Drop or TinyML Voice ("Tolong!") Detection:** Deferred to post-MVP iterations to keep initial implementation focused and maintainable.
- **No Full Hardware-Keystore Ed25519 Signing or Heavy PoW Mining Loops:** `AUTH_SIG_128` and `POW_NONCE` fields are preserved in the 56-byte `SMPv1` structure, with lightweight placeholder/basic verification in MVP so device batteries are not strained during development testing.

### 6. Design Considerations
- **Unified Tactical / Utility Dashboard:** Combine top/primary visual telemetry (**Relative Compass Radar** + **18.5–20 kHz FFT Spectrum**) with a lower/tabbed **Offline Coordinate & SOS Packet Panel** so the user sees live signal bearings, ultrasonic frequency spikes, and decoded SOS records without jumping across disconnected screens.
- **Clear Status Badges:** Display `Airplane Mode / Offline` indicator, active `Trigger Flag` (`MANUAL`, `SENSOR_SOS`, `DAILY_RADAR`, `WITNESS_PIN`), `ENV_STATE` (`POCKET/BAG` vs `OPEN`), GPS coordinates + accuracy bucket, quantized battery level, and packet `AGE_SEC`.
- **High-Contrast Controls:** Large, unmistakable buttons for **Trigger SOS**, **Cancel Countdown**, **Calibrate Noise (3s)**, and **Stop Siren (3.5 kHz)**.

### 7. Technical Considerations
- **React Native + Expo Development Build:** Because custom Kotlin modules (`AudioTrack`, `AudioRecord`, FFT, BLE `ScanFilter`/`PendingIntent`, `ForegroundService`) and background permissions are required, the app must be built via Expo Development Build (`npx expo prebuild`) or bare Android project rather than standard Expo Go.
- **Acoustic Constraints:** Most consumer phone speakers and microphones roll off sharply above 18–20 kHz; keep FSK tone spacing and baud rate conservative enough for reliable short-range phone-to-phone testing and expose tone/threshold parameters in config constants for easy tuning.
- **Android OEM Battery Policies:** Include `FOREGROUND_SERVICE_CONNECTED_DEVICE`, `BLUETOOTH_SCAN`, `BLUETOOTH_ADVERTISE`, `BLUETOOTH_CONNECT`, `ACCESS_FINE_LOCATION` (for BLE scan & GPS coordinates), and `RECORD_AUDIO`, plus a helper to open battery optimization settings.
- **Coordinate Handling:** Use offline GPS last-known/current fix (`int32` scaled by $10^7$) and render relative bearing/distance or local coordinate grid when map tiles are unavailable.

### 8. Success Metrics
- **SM-1 (End-to-End Ultrasonic Transfer):** Two Android phones in *Airplane Mode* successfully transmit and decode a valid 56-byte `SMPv1` packet (passing `CRC16`) over 18.5–20 kHz audio at short range (e.g., 0.5–2 meters) in a quiet/calibrated room.
- **SM-2 (BLE Multi-Hop Deduplication):** A test packet with `TTL >= 2` hops across intermediary devices without infinite looping (`PACKET_ID` deduplication prevents duplicate re-broadcasts).
- **SM-3 (Sensor & Pocket Trigger Flow):** Simulating an `Accelerometer` shock and dark `Light Sensor` state transitions the app into SOS state and allows triggering/stopping the 3.5 kHz siren reliably.
- **SM-4 (Unified UI Responsiveness):** Radar bearing/signal indicator, 19 kHz FFT spectrum display, and offline coordinate/SOS packet list update smoothly without freezing the JS thread.

### 9. Open Questions
- **OQ-1 (Exact FSK Parameters):** What exact center frequencies (within 18.5–20 kHz) and symbol duration (ms per bit/symbol) give the highest decode success rate across the specific test Android phones available?
- **OQ-2 (Offline Coordinate Visualization):** Should the offline coordinate view render a lightweight local coordinate/bearing plot (canvas/SVG) alongside raw lat/lon + distance/bearing cards, or bundle a small static local map asset?
- **OQ-3 (Light Sensor Threshold):** What lux threshold best distinguishes "inside pocket/bag" from "dim indoor room" on the target test devices without false positives?
