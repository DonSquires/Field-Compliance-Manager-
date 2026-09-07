# FCM SD Card Bridge

Local Windows utility for inspecting a copied `SDFileInfo.db` CCTV index before footage extraction is implemented.

## Current milestone

- Opens only a user-selected `SDFileInfo.db` file.
- Opens SQLite in read-only mode and calculates a source SHA-256.
- Displays motion-recording metadata, event labels, timestamps, and vendor cluster references.
- Does not access physical disks, read raw partitions, export footage, upload to FCM, or store credentials.

## Security model

- Use a copied folder or a read-only disk image; never modify the original SD card.
- A future browser-to-bridge handoff must use an expiring, one-time exchange identifier, never a JWT in `fcm-bridge://`.
- A future exporter must preserve image hash, partition offset, record number, cluster/index coordinates, extraction hash, and tool version in evidence metadata.
- Face detections remain manual-review candidates. No automatic identity or incident linkage is permitted.

## Windows build prerequisite

Install Rust (`rustup`), Visual Studio Build Tools with the Desktop development with C++ workload, Node.js 22+, and WebView2. Then run:

```powershell
cd apps/sd-card-bridge
npm install
npm run tauri dev
```

Do not add raw-sector extraction until the format mapping is proven from a read-only disk image.