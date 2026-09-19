# FCM Desktop V2

Desktop V2 is the Windows companion the web app links to for Dahua cards, built beside the older `apps/sd-card-bridge` application.

## Purpose

The card is the source. V2 reads the hidden DHFS partition straight from the card and sends recordings to FCM:

1. Discover the card without opening a write handle (the app elevates once at start so the raw disk can be read).
2. List every trustworthy recording on the hidden partition, straight from the card.
3. Sign in with the operator's own FCM login, choose the place the camera watches and a camera label, and create a
   `cctv_imports` row through the same `create_cctv_import` RPC the web import page uses.
4. Send recordings: each is read from its fragments into the working folder (SHA-256 taken as it leaves the card),
   uploaded with the tus resumable protocol into `org/<org>/cctv/<import>/`, and registered with
   `register_cctv_import_video` carrying that hash, so the analysis worker verifies rather than first-anchors it.
   A picture-stream recording (Dahua's event stills) is sent as dated timeline events with thumbnails through
   `record_cctv_device_events` instead of as video.
5. Optionally acquire an exact image of the whole card (a forensic bit-for-bit copy, empty space included) and inspect it
   as a virtual source. Not needed to send recordings.

### What a recording's bytes on the card actually are (measured 2026-09-19)

The descriptor chain points at whole fragments, but a recording is not the whole fragment:

- The first fragment opens with a header/index area (`DHII`, JSON encode settings — which contain the literal word
  `DHAV` — and index space). Unused index space is never erased, so it still holds frames from whatever occupied the
  flash before, weeks or months older. Extraction rule 1 started at the first `DHAV` bytes and therefore shipped JSON
  plus up to 1.6 MB of a previous occupant's frames ahead of the real recording; FFmpeg rejected or decoded the wrong footage.
- Every 512-block group ends with a 4 KiB write-checkpoint block (CRC, magic `13 57 75 31`, counter, begin time, last
  write time, descriptor index). A frame that straddles it simply continues after it.
- The descriptor's last-fragment block count can under-report while frames continue, and the true end is erased flash (`0xFF`).
- Channel byte `0x70` is the picture stream: back-to-back 1920×1080 JPEGs about one per second, each carrying a
  `DHAV` 0xfb header (with the capture time) inside a comment segment.

Extraction rule 2 (`-r2` in file names) therefore walks frames: header validated against its trailer, checkpoint
blocks removed, only frames the camera dated inside the recording kept (pre-record tolerance 90 s, 15 s after),
output starting at a key frame, stopping at erased flash or the next recording. `ExtractionStats` on every clip say
how much was stale, unstructured or bookkeeping. `cargo run --example replay -- <region> <fragment-offset> <begin> <end> <out>`
replays a copied region through the walker without the card.

The publishable Supabase key in `src/main.tsx` is the same public key the web bundle ships; every read and write runs as
the signed-in user under row-level security, and the session is held in memory only.

## Native commands

- `discover_read_only_devices`
- `acquire_read_only_device_image`
- `inspect_acquisition_image`
- `read_dhfs_catalog` — locate the hidden DHFS4.1 partition (sector 0, MBR/GPT
  entry, or sector scan), walk its partition table, superblock and fragment
  descriptors, and list every trustworthy recording. Accepts either the
  verified image (`{ kind: 'image', path }`) or the card itself
  (`{ kind: 'device', id, sizeBytes }`), both opened read-only.
- `extract_dhfs_recording` — write one recording out of the volume as a decodable stream (rule 2 above): video
  as one `.dav`/`.h26x` file, a picture stream as a folder of dated JPEGs, SHA-256 recorded, written atomically
  and never over existing evidence. With `reuseExisting`, a finished copy already in the folder is re-hashed and
  returned instead of refused.
- `default_clip_directory` — the per-card working folder under Public
  Documents, created on demand so the operator never has to pick one.
- `upload_clip_resumable` / `cancel_upload` — tus resumable upload of one
  extracted recording into `bob-uploads` with 6 MiB chunks, per-chunk
  `upload-progress` events, offset resync on transport errors, and an
  `unauthorized` outcome that hands the resumable URL back so the interface can
  refresh the session and continue from the same offset.
- `decoder_status` / `install_decoder` — the on-demand decoder (FFmpeg 8.1.2, BtbN `win64-lgpl` build, run as a
  separate process). Installed under the app's local data folder, one folder per pinned version; the SHA-256 of
  the binary and of `LICENSE.txt` are compiled into the app and checked on every use, so a swapped or
  half-downloaded file shows as `rejectedReason` and is never run. `install_decoder` streams to a `.part` file,
  emits `decoder-progress`, and only commits the file once the hash matches.
- `render_filmstrip` — key frames spread across an extracted recording as small JPEGs (base64) with each frame's
  offset from the clip start, so the interface can label them with the camera clock.
- `render_preview` / `clear_previews` — a 480p H.264 viewing copy under `<app local data>/previews/`
  (`h264_nvenc` first, `libx264` when no NVENC device answers), played in-app through the asset protocol whose
  scope is exactly that folder. A reused copy from an earlier run is reported as `cached` with no encoder
  claim. Previews are derived viewing aids: never uploaded, never registered, and removable at any time.
- `export_mp4` — "Save to folder": next to the hashed `.dav` the operator asked for, a full-resolution `.mp4` for their
  own use. H.264 sources are copied frame for frame; anything else (Dahua cards are usually HEVC, which a stock
  Windows install cannot play) is re-encoded to H.264 on the GPU, or in software when no NVENC device answers.
  Video only; an existing `.mp4` in that folder is kept, never overwritten. The `.dav` remains the evidence.
- `list_video_files` / `hash_local_file` / `probe_video_file` — the second source, "Video files": any folder this
  computer can see (camera exports, downloads, synced cloud folders). Files are listed by recorded day, hashed
  where they lie before sending, and their duration / codec / container `creation_time` read from the decoder's
  banner. The recorded start comes from the file name when a recorder wrote one there, else the container's
  creation time, else an estimate from the modified time — the source is shown next to an editable field and
  recorded in the import manifest (`start_time_source`).

"Review here" (0.4.0) lets the operator preview a recording on the laptop and choose **Send** or **Skip** per
recording; skipped recordings are left out of "Send all". Sending itself is unchanged: the `-r2` original with
its card-side SHA-256 goes to `register_cctv_import_video`. 0.4.1 added the "Video files" source and "Save to
folder" (hashed original + playable MP4 wherever the operator chooses). The plan for local analysis is
`docs/DESKTOP_LOCAL_PROCESSING_PLAN.md`.

The DHFS logic lives in `crates/dhfs` (`fcm-dhfs`), a dependency-light crate
with its own unit tests over synthetic cards (MBR-hidden partition, raw device
start, all-zero partition table with the `0x6c0` superblock fallback, DHII
trim, DHAV frame headers, cyclic/zero-length descriptors). Run them with
`cargo test --manifest-path crates/dhfs/Cargo.toml`; the release workflow runs
them before building the installer. The decoder's pure parts (pinned hashes,
ffmpeg argument lists, `showinfo` parsing, encoder fallback detection) live in
`crates/decoder` (`fcm-decoder`) with their own tests, also run by the workflow.

Why Windows shows nothing: Dahua cards carry no mountable filesystem. The card
is either raw DHFS from sector 0 or a RAW partition whose contents are DHFS, so
Explorer offers no drive letter. That is the "hidden partition"; the reader
above is how it is read.

The current native acquisition implementation targets Windows physical devices. The UI intentionally presents unknown adapter results as investigation candidates rather than successful decoding.

## Run

```bash
npm install
npm run dev
```

For a Tauri build, install the platform prerequisites and run `npm run tauri dev`.
