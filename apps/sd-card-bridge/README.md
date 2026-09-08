# FCM SD Card Bridge

Local Windows utility for read-only SD/DHFS inspection, evidence preparation, and hybrid CCTV handoff.

## Current milestone

- Opens a user-selected `SDFileInfo.db` file or reads supported recordings directly from a connected card.
- Opens SQLite in read-only mode and calculates a source SHA-256.
- Displays motion-recording metadata, event labels, timestamps, and vendor cluster references.
- Signs users in against FCM using public browser configuration fetched at startup; passwords and service credentials are never sent to the configuration endpoint.
- Uploads exported MP4/MOV/AVI/MKV footage to private FCM storage and queues the hybrid `video_motion` pipeline: RunPod GPU inference first, with VPS inference as the fallback.
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

## Code signing (required to avoid antivirus/SmartScreen warnings)

Unsigned Windows executables are routinely flagged by AVG, Defender SmartScreen, and other antivirus products as "suspicious" purely because the publisher is unverified, regardless of what the code does. The release workflow (`.github/workflows/release-sd-card-bridge.yml`) will automatically sign the installer once a real Authenticode code-signing certificate is added as a GitHub Actions secret:

1. Purchase an OV or EV code-signing certificate from a Certificate Authority such as DigiCert, Sectigo, or SSL.com. This requires real organization identity verification and cannot be generated or substituted in code; a self-signed certificate does not remove the warning.
2. Export the certificate as a password-protected `.pfx`/`.p12` file.
3. Base64-encode it (`certutil -encode cert.pfx cert.b64` on Windows, or `base64 -w0 cert.pfx` on Linux/macOS) and add it as the repository secret `WINDOWS_CERTIFICATE`.
4. Add the certificate's export password as the repository secret `WINDOWS_CERTIFICATE_PASSWORD`.
5. Tag a new release; the workflow signs `FCM-SD-Card-Bridge-Setup.exe` with `signtool` and a timestamp server automatically. Builds without these secrets remain unsigned and will continue to trigger antivirus warnings.

An EV certificate gets immediate SmartScreen reputation; an OV certificate builds reputation over time as more people run the signed installer.