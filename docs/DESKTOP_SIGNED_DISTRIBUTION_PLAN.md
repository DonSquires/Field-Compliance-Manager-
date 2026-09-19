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

## Phase 1 — sign with our own certificate (ready, free)

`scripts/desktop-signing/New-FcmSigningCertificate.ps1` creates one stable self-signed code-signing
certificate (RSA-3072, SHA-256, Code Signing EKU, 3 years) and prints the two values to store as GitHub
Actions secrets: `FCM_DESKTOP_SIGNING_PFX_BASE64` and `FCM_DESKTOP_SIGNING_PFX_PASSWORD`. Once they exist,
every release is Authenticode-signed with an RFC 3161 timestamp, `signtool verify` runs in CI, the public
certificate `FCM-Desktop-Signing.cer` is published beside the installer, and the manifest records
`signed: true` with the signer subject and thumbprint.

What it buys:

- Tamper evidence: a modified installer fails signature verification.
- A named publisher ("Iron Eagle Security Ltd") in the elevation prompt on any machine that trusts the
  certificate; and a single object for fleet trust — Intune / Group Policy pushes the `.cer` into
  **Trusted Publishers** (and **Trusted Root**, since it is self-issued), or an AppLocker / WDAC
  publisher rule allows it.

What it does not buy: Microsoft SmartScreen reputation. Unmanaged machines still see "Windows protected
your PC" until Phase 2. That is stated in the release notes and in the download prompt rather than hidden.

Rotation: the PFX lives offline (password manager / vault), never in the repository. Rotating = run the
script again, replace the two secrets, publish the new `.cer`. Old installers stay valid because they are
timestamped.

## Phase 2 — publicly trusted signature (when the system is proven; paid)

Swap the secret, not the pipeline:

| Option | Cost (indicative) | Trust | Notes |
| --- | --- | --- | --- |
| Azure Trusted Signing | ~USD 10 / month | Public CA, SmartScreen reputation accrues quickly | Identity validation of the legal entity (NZBN on file already). Replace the `signtool /f pfx` step with the Trusted Signing `signtool` dlib + `AzureSignTool`/OIDC. |
| OV code-signing certificate (hardware token / cloud HSM, CA/B Forum rules since 2023) | ~USD 200–400 / year | Public CA; SmartScreen reputation builds over downloads | Key must sit in an HSM/token, so CI signing needs a cloud HSM or a self-hosted signer. |
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
