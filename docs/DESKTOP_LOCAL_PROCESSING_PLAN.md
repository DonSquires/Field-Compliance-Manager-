# Desktop local processing — build plan (owner-approved 2026-09-19)

**Why.** Sending every recording to the VPS costs upload bandwidth the field laptop does not have, and the VPS
transcodes HEVC at ~1 recording/min. The laptop (i7-14650HX, RTX 5050) can decode, preview and analyse locally;
FCM should let the operator choose, per import, between **reviewing/processing here** and **sending to FCM**.
Both paths must land on the same spines (import → evidence → observations → review) with the same custody rules.

**Where it lives.** `apps/sd-card-bridge-v2` (Tauri 2, crate `fcm-dhfs`). Card reading, hashing and sending are
already there (0.3.0). This plan adds three phases; each ships as a signed V2 release through the existing
`scripts/desktop-signing/sign-and-publish.mjs` pipeline.

## Phase 1 — Review here (0.4.0)

Goal: see what a recording holds *before* it leaves the machine, and send only what matters.

- **Decoder sidecar.** FFmpeg 8.1.2, BtbN `win64-lgpl` static build (LGPL configuration, no GPL components; FCM
  invokes it as a separate process, so FCM is not a derivative work). Published to
  `desktop-releases/tools/ffmpeg/8.1.2-c573a95381/` (`ffmpeg.exe` 132,239,360 B, `LICENSE.txt`, `manifest.json`)
  by `scripts/desktop-tools/publish-ffmpeg-sidecar.mjs`. V2 downloads it on demand to
  `%LOCALAPPDATA%\nz.fcmanager.desktop.v2\tools\`, verifies SHA-256
  `56f015b477f6fc7923409bb63217d2ee7b2b8d236c599ba94e1cf72220548e8c` against a constant compiled into the app, and
  refuses anything else. The licence notice and source link are shown in-app.
- **Filmstrip.** Per recording, key frames spread across the clip (from the `-r2` extraction, so only the
  recording's own frames), labelled with the camera clock — enough to tell "van at the gate" from "nothing".
- **Preview playback.** On request, a 480p H.264 rendition (NVENC when present, libx264 otherwise) written under
  the app's local data folder and played in-app. This is a viewing aid only: it is never uploaded and never
  registered as evidence.
- **Choice per recording.** Preview → Send / Skip. Sending is unchanged: the `-r2` original with its card-side
  SHA-256 goes to `register_cctv_import_video`.

Not in Phase 1: any change to what FCM stores; any inference on the laptop.

**Ruling 2026-09-19 (owner, after the 0.4.0 field test) — shipped as 0.4.1:** V2 gains a second source, **Video
files** — any folder the computer can see, including synced cloud folders — so an MP4 or other video that did not
come off a card goes through the same preview / send / skip flow, hashed before it leaves, with its recorded start
derived from the file name, container metadata or modified time (source shown, operator can correct it, and it is
recorded in the manifest). "Extract" became **Save to folder**: a folder picker every time, the hashed `.dav`
original plus a playable full-resolution MP4 (H.264 copied; HEVC re-encoded on the GPU) for the operator's own use.
The MP4 is a derived copy and never the evidence. Also fixed: the DHAV `0x80` extension is 4 bytes, not 6 — the
0.4.0 parser stepped into the codec extension and reported "UNKNOWN video"; reused `-r2` files now have their
frames counted, so the filmstrip spans the whole recording instead of its first 24 seconds.

## Phase 2 — Analyse here (0.5.x)

Goal: the laptop runs the same detection/recognition tier the VPS runs and FCM receives **results**, not footage,
unless the operator (or a rule) asks for the footage.

- **Analysis pack.** An optional install (~1.5 GB): ONNX Runtime (DirectML/CUDA) + the staged models
  (RF-DETR, plate detector + OCR, YuNet/SFace, SpeciesNet). Pinned hashes, same install pattern as the decoder.
  Licences already vetted for the inference tier (Apache-2.0/MIT; no AGPL).
- **Same pipeline, same outputs.** Port of `video_motion_extractor.py` (motion windows on the container clock),
  frame classification, `motion_consolidator` rules (tracks, portfolios, quality gate) — producing the same
  `motion_summary` shape the worker produces, so `record_cctv_entity_observations` / `record_cctv_device_events` /
  `complete_motion_inference` accept it unchanged.
- **Governed intake for desktop results.** Today those RPCs are service-only, called by the VPS worker with a
  signed workload token. Desktop results need an *authenticated-user* path: a new Edge Function
  (`cctv-desktop-analysis-intake`) that derives org/user from the session, checks `org_access_allowed`, validates
  the summary shape and size, records provenance (`analysis_origin: desktop`, app version, model hashes, GPU),
  and then calls the same service RPCs. No service-role key ever reaches the laptop.
- **Evidence without upload.** `register_cctv_import_video` gains a mode where the evidence row carries the
  card-side SHA-256 and `storage_path = null` with `retained_at: desktop` — the recording stays on the laptop's
  working folder (and card), keyframes/thumbnails go up (kilobytes), and the console shows "footage held on
  <device>, request upload" instead of a player. Requesting upload triggers the existing resumable send and the
  worker's integrity check verifies the hash that was registered first.
- **Custody.** Hash at extraction, hash recorded at registration, hash verified on any later upload — the chain
  is identical to today's; only *when* the bytes travel changes.

## Phase 3 — Operate as a station (0.6.x)

- Batch mode: card in → list → analyse all → review locally → send results, with a resumable job list that
  survives closing the app.
- Multi-card sessions per place; re-detection of the same camera by `camera_key`.
- Offline: queue registrations and results while disconnected; replay in order when online, idempotently
  (idempotency already exists on `(import, source_ref)`).

## Rules that bind all phases

- The card is never written. Working copies are `-r2` extractions with hashes; previews are derived, unregistered.
- Nothing on the laptop ever holds a service credential; every write is the signed-in user's own action under RLS.
- Every result carries provenance (device, app version, decoder/model versions and hashes) so a desktop analysis
  and a VPS analysis of the same recording are distinguishable in the console and in reports.
- Accuracy issues found in the 2026-09-19 review (stationary object re-counted as five vehicles; occupants through
  glass over-counted; "bus" for a ute; occlusion passing the quality gate) are fixed in the shared consolidator /
  extractor so both paths improve together — not patched in one path only.
