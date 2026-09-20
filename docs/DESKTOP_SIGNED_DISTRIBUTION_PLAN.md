# FCM Desktop: signed distribution plan

Owner rulings this plan rests on: "we need our own system" (the Dahua card reader is ours, not a DVR
export); "sign with our own temporary certificate — I'm not spending $$ on a certificate until we
have a working system" (2026-09-18). The plan therefore has a free phase that is real now, and paid
phases that are a secret swap, not a rebuild.

## What the installer is today

- `apps/sd-card-bridge-v2` (Tauri 2, NSIS, `installMode: currentUser`), built by
  `.github/workflows/release-sd-card-bridge-v2.yml` on `windows-latest`, published as a GitHub
  pre-release and copied to Supabase Storage `desktop-releases/v2/<version>/FCM-Desktop-V2-Setup.exe`,
  which is what the web download prompt points at (`AdminShell.tsx`, `DESKTOP_V2_VERSION`).
- Reading a Dahua DHFS card means opening `\\.\PhysicalDriveN` raw, so the app itself must run as
  administrator; the installer does not need elevation.
- Field lesson (0.1.7): endpoint security reacts to what an unsigned binary *does*. Spawning PowerShell
  with `-ExecutionPolicy Bypass` was enough to block the install; removing it (0.1.8) fixed it. Keep the
  binary's behaviour boring: no policy bypasses, no writes outside its own profile, no network beyond
  Supabase.

## Phase 0 — integrity you can check (done, free)

The release workflow now:

1. Computes the installer's SHA-256 and publishes `SHA256SUMS` and `manifest.json` (version, hash, size,
   git SHA, build time, whether/by whom it is signed, and the exact `certutil` command to verify) next to
   the installer — on the GitHub release and, when storage credentials are configured as repository
   secrets (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`), directly in `desktop-releases/v2/<version>/`.
2. Prints the hash and the signing state in the release notes in plain words.

Operator check before running any installer:

```powershell
certutil -hashfile FCM-Desktop-V2-Setup.exe SHA256
# compare with manifest.json / SHA256SUMS / the release page
```

## Phase 1 — sign with our own certificate (live, free; key lives in Supabase, not GitHub)

Owner direction 2026-09-19: the signing material belongs in Supabase, not GitHub. So GitHub only
*builds*; signing and publishing happen on the protected side with the service role.

1. **Certificate (once).** Minted on the protected side by
   `scripts/desktop-signing/mint-signing-certificate.mjs` (openssl: RSA-3072, SHA-256, Code Signing EKU,
   3 years) and stored straight into Vault; the private key existed only in a 0700 temp dir and was
   shredded. Done 2026-09-19: publisher `CN=Iron Eagle Security Ltd, O=Iron Eagle Security Ltd, C=NZ`,
   thumbprint `CA51E5196C5320E1C5F40253D62A6C308351EAEF`, valid to 2029-09-18. (A certificate minted
   earlier on Windows with `New-FcmSigningCertificate.ps1`, thumbprint `F638…3D7B`, was never stored and
   is not in use; that script remains the Windows route for a future rotation.)
2. **Vault (once per rotation).** Two secrets in Supabase Vault (Dashboard → Project Settings → Vault, or
   `select set_desktop_signing_material(<base64>, <password>)` as the service role):
   `desktop_signing_pfx_base64` and `desktop_signing_pfx_password`. Migration `20260919010000` adds the
   service-only reader `desktop_signing_material()`; **every read is written to `audit_log`** by name.
   Browser roles cannot call either function.
3. **Sign + publish (per release).** After the tag builds on GitHub:

   ```bash
   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… node scripts/desktop-signing/sign-and-publish.mjs --tag sd-card-bridge-v2-v<version>
   ```

   Downloads the unsigned asset with `gh`, fetches the PFX from Vault into a 0700 temp dir, signs with
   `osslsigncode` (SHA-256, RFC 3161 timestamp from DigiCert), verifies against the signer certificate,
   wipes the PFX, then publishes the signed installer, `SHA256SUMS`, `manifest.json` (signed, signer,
   thumbprint, timestamped) and the public `FCM-Desktop-Signing.cer` to `desktop-releases/v2/<version>/`
   — the location the web app links to — and replaces the GitHub release assets with the signed set.
   Runs from the VPS or an operator Codespace. **Done for 0.1.8 on 2026-09-19:** signed installer
   SHA-256 `353331aa8c34d0c5ab4b54f06f051e67dc9844d249529a9d289c00d3b769fb71` (2,160,256 bytes),
   DigiCert timestamp, `Signature verification: ok` re-checked from the public URL; GitHub release
   assets replaced with the signed set. The bucket allow-list was widened for the artefacts
   (`20260919020000`). **0.1.9 signed the same way on 2026-09-19** (self-elevating build so the raw
   Dahua disk opens without a manual "Run as administrator"): SHA-256
   `faf6034cb661cc8209662b6722eaac1af3e1e8c9d6c3698060dd1ab49cfbce2b`, verified from the public URL;
   the web app's download link points at 0.1.9. **0.2.0 signed the same way on 2026-09-19** (the card
   is the drive: V2 signs in with the operator's FCM login, lists recordings from the hidden partition
   and sends them straight into the tenant's import with the card-side SHA-256; the exact image is now
   an optional forensic copy): SHA-256 `fa217440f8a8e7ee7d29d151ca403e1dcb7a2319e63c03bd7bc13c96b332144d`
   (2,892,976 bytes), verified from the public URL; the web app's download link points at 0.2.0.
   **0.3.0 signed the same way on 2026-09-19** (extraction rule 2: only the recording's own frames, checkpoint
   blocks removed, picture streams as dated JPEGs — see `apps/sd-card-bridge-v2/README.md`): SHA-256
   `9f6d66125111908775ce6ad53e3f8088986b90cbbd42775f3cb55ec7ae3767e2` (2,911,424 bytes), verified from the
   public URL; the web app's download link points at 0.3.0. **0.4.0 signed the same way on 2026-09-19** ("Review
   here": on-demand FFmpeg decoder pinned by hash, key-frame filmstrip and 480p viewing copy rendered on the
   laptop, Send/Skip per recording — see `docs/DESKTOP_LOCAL_PROCESSING_PLAN.md`): SHA-256
   `21c4a868a8ed2f82d2e801fa064e8db2aae939948c8475da8269f9746ea62137` (2,984,400 bytes), verified from the
   public URL; the web app's download link points at 0.4.0. The decoder sidecar it downloads is published
   separately at `desktop-releases/tools/ffmpeg/8.1.2-c573a95381/` (BtbN `win64-lgpl` build, `ffmpeg.exe`
   SHA-256 `56f015b477f6fc7923409bb63217d2ee7b2b8d236c599ba94e1cf72220548e8c`, 132,239,360 bytes, with
   `LICENSE.txt` and `manifest.json`); the app refuses any file whose hash differs from the constant compiled
   into it. The sidecar is not Authenticode-signed by us — it is verified by hash, and it runs as a separate
   process, never loaded into FCM. **0.4.1 signed the same way on 2026-09-19** ("Video files" as a second source,
   "Save to folder" with a playable MP4, working rail navigation, DHAV header-parse fix): SHA-256
   `989c0ad68ba2103bd2498d1f26e1fe3e1b05bde9d989eb4f19103c6533bac23c` (3,007,128 bytes), verified from the
   public URL; the web app's download link points at 0.4.1. **0.4.2 signed the same way on 2026-09-20** (saved
   state per recording, file picker for the video-files source, picture-stream review, pop-out preview window):
   SHA-256 `0d9b9a9620b20da1009effc72f63da2c36b6396c510c716284110e34e0c53ee0` (3,027,664 bytes), verified from
   the public URL; the web app's download link points at 0.4.2.

What it buys:

- Tamper evidence: a modified installer fails signature verification.
- A named publisher ("Iron Eagle Security Ltd") in the elevation prompt on any machine that trusts the
  certificate; and a single object for fleet trust — Intune / Group Policy pushes the `.cer` into
  **Trusted Publishers** (and **Trusted Root**, since it is self-issued), or an AppLocker / WDAC
  publisher rule allows it. The `.cer` is published at `desktop-releases/v2/FCM-Desktop-Signing.cer`.
- The private key is only ever in Vault (encrypted at rest, service-role reads audited) and the owner's
  offline copy. GitHub Actions holds neither the key nor a Supabase credential.

What it does not buy: Microsoft SmartScreen reputation. Unmanaged machines still see "Windows protected
your PC" until Phase 2. That is stated in the release notes and in the download prompt rather than hidden.

Rotation: run the certificate script again, store the new values with `set_desktop_signing_material`
(it updates in place, audited), publish the new `.cer`. Old installers stay valid because they are
timestamped.

## Phase 2 — publicly trusted signature (when the system is proven; paid)

Swap the Vault secret (or the signing step), not the pipeline:

| Option | Cost (indicative) | Trust | Notes |
| --- | --- | --- | --- |
| Azure Trusted Signing | ~USD 10 / month | Public CA, SmartScreen reputation accrues quickly | Identity validation of the legal entity (NZBN on file already). Signing moves to Microsoft's service (`signtool` dlib / `AzureSignTool`); the Vault then holds the Azure client credential instead of a PFX. |
| OV code-signing certificate (hardware token / cloud HSM, CA/B Forum rules since 2023) | ~USD 200–400 / year | Public CA; SmartScreen reputation builds over downloads | Key must sit in an HSM/token, so signing needs a cloud HSM (`osslsigncode` supports PKCS#11) or a self-hosted signer. |
| EV code-signing certificate | ~USD 300–600 / year | Public CA; immediate SmartScreen reputation | Same HSM constraint; best user experience for unmanaged machines. |

Decision to make then: if FCM Desktop only ever runs on managed fleets, Phase 1 + WDAC may be enough
indefinitely. If officers install it on their own machines, Phase 2 is required for a clean install.

## Phase 3 — release hygiene that makes signing meaningful

- Reproducible source: the manifest's `git_sha` must match a tag `sd-card-bridge-v2-v<version>` on `main`.
- Version everywhere: `package.json`, `Cargo.toml`, `tauri.conf.json`, and `DESKTOP_V2_VERSION` in
  `AdminShell.tsx` change together (0.1.4 shipped as "0.1.0" once; it cost a field debugging session).
- The web prompt should read `manifest.json` for the version and hash rather than a hard-coded constant.
- An uninstall/upgrade path: NSIS `currentUser` installs upgrade in place; keep the product GUID stable.
- Never put a policy bypass, credential, or telemetry in the binary that a defender would flag; the
  0.1.7 regression is the standing example.

## Non-goals

- We are not building an operating system or a DVR. The Windows workstation is the operator's; FCM
  Desktop is a signed, checkable tool on it.
- We do not bundle drivers or filter drivers for card access; raw physical-drive reads as administrator
  are sufficient and stay inside Windows' own trust model.
