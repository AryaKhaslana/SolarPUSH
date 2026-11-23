# SolarPUSH · SonarMesh

Offline P2P Disaster & SOS Communication App (Software-Only MVP) for standard Android devices. Built with **React Native (Expo Development Build)** and custom **Kotlin Native Modules** combining **18.5-20 kHz near-ultrasonic FSK acoustic signaling**, **Bluetooth Low Energy (BLE) multi-hop relaying**, and a compact **56-byte Big-Endian binary protocol (`SMPv1`)**.

Full product specification: [tasks/prd-sonarmesh.md](./tasks/prd-sonarmesh.md)

## Architecture

```text
React Native Unified Tactical UI (App.tsx)
  ├── Relative Compass Radar (SVG, heading + Haversine/RSSI bearing)
  ├── Live 18.5-20 kHz FFT Spectrum + 3s Noise-Floor Calibration
  ├── Offline Coordinate Grid + Local SQLite / Storage Persistence
  └── Multi-Trigger SOS Controls + 3.5 kHz Siren Silence Control
            │
            ▼  Expo Local Native Module Bridge (modules/sonarmesh-native)
Android Kotlin Native Layer
  ├── protocol/SmpV1Codec.kt           (56-byte Big-Endian codec + CRC-16 CCITT-FALSE + Dedup)
  ├── audio/Radix2FFT.kt               (Pure Kotlin Cooley-Tukey Radix-2 FFT + Hann window)
  ├── audio/UltrasonicModem.kt         (48 kHz AudioTrack FSK TX + AudioRecord RX + 3.5 kHz Siren)
  ├── ble/BleMeshTransport.kt          (BLE ScanFilter, Extended/Legacy Adv, TTL-1 + 200-2000ms jitter)
  ├── ble/SonarMeshForegroundService.kt(connectedDevice + on-demand microphone ForegroundService)
  └── sensors/SensorTriggerManager.kt  (Accelerometer impact spike, Light pocket/bag lux, Compass)
```

## `SMPv1` 56-Byte Binary Packet Layout (Big-Endian)

| Offset | Size | Field | Description |
| :--- | :--- | :--- | :--- |
| `0` | 1 B | `MAGIC_VER` | Constant `0x51` |
| `1` | 1 B | `FLAGS_TTL` | `[7:6]` Trigger (`MANUAL`/`SENSOR_SOS`/`DAILY_RADAR`/`WITNESS_PIN`), `[5]` `ENV_STATE` (`POCKET/BAG`), `[4]` `SIREN_REQ`, `[3:0]` `TTL` (`0..15`) |
| `2..9` | 8 B | `PACKET_ID` | Unique 64-bit packet identifier for deduplication |
| `10..11` | 2 B | `SEQ_COUNTER` | Per-sender `uint16` sequence counter |
| `12..15` | 4 B | `LATITUDE` | `int32` scaled by `10^7` |
| `16..19` | 4 B | `LONGITUDE` | `int32` scaled by `10^7` |
| `20` | 1 B | `GPS_ACC_BATT` | `[7:4]` GPS accuracy bucket (`0..15`), `[3:0]` quantized battery (`0..15`) |
| `21..22` | 2 B | `AGE_SEC` | Elapsed seconds since packet creation (`uint16`) |
| `23..26` | 4 B | `SENDER_HINT` | Short 32-bit node identifier |
| `27..28` | 2 B | `POW_NONCE` | Reserved lightweight PoW nonce (`uint16`) |
| `29..37` | 9 B | `SHORT_PAYLOAD` | Compact UTF-8 emergency note (zero-padded) |
| `38..53` | 16 B | `AUTH_SIG_128` | 128-bit lightweight MVP integrity tag |
| `54..55` | 2 B | `CRC16` | CRC-16/CCITT-FALSE (`poly 0x1021`, `init 0xFFFF`) over bytes `0..53` |

Acoustic framing prepends `0xAA 0xAA 0x2D 0xD4` (4 bytes preamble + sync word) for a total 60-byte acoustic frame.

## Development & Testing

```bash
# Install JS dependencies
npm install

# Run TypeScript strict typecheck + SMPv1 binary protocol unit tests
npm run typecheck
npm test

# Run browser preview with live software loopback (FFT, 3.5 kHz Web Audio siren, SMPv1 simulator)
npm run web

# Generate native Android Gradle project and build Development APK (requires JDK 17 + Android SDK)
npm run prebuild:android
npm run android
```

NixOS users can enter a reproducible shell with JDK 17, Kotlin, Node 22, and `adb` via `nix develop`.

## License

MIT
