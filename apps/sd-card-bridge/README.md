# FCM SD Card Bridge

Local Windows utility for inspecting a copied `SDFileInfo.db` CCTV index before footage extraction is implemented.

## Current milestone

- Opens only a user-selected `SDFileInfo.db` file.
- Opens SQLite in read-only mode and calculates a source SHA-256.
- Displays motion-recording metadata, event labels, timestamps, and vendor cluster references.
- Signs users in against FCM using public browser configuration fetched at startup; passwords and service credentials are never sent to the configuration endpoint.
- Uploads exported MP4/MOV/AVI/MKV footage to private FCM storage and queues the existing VPS `video_motion` pipeline.
- Stages one selected recording at a time through an atomic `.part` -> ready cache before upload; failed reads or uploads remain retryable and successful Bob registration clears the cache.
- Reads normal DHFS recordings directly off the physical card and extracts one selected recording straight into the retryable cache, with no full-card image and no NVR/VMS client required.
- The built-in DHFS parser also supports a read-only full image as an optional forensic-preservation mode; it is not required for normal clip intake.

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