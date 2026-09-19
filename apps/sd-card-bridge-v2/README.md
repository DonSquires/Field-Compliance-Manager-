# FCM Desktop V2

Desktop V2 is the Windows companion the web app links to for Dahua cards, built beside the older `apps/sd-card-bridge` application.

## Purpose

The card is the source. V2 reads the hidden DHFS partition straight from the card and sends recordings to FCM:

1. Discover the card without opening a write handle (the app elevates once at start so the raw disk can be read).
2. List every trustworthy recording on the hidden partition, straight from the card.
3. Sign in with the operator's own FCM login, choose the place the camera watches and a camera label, and create a
   `cctv_imports` row through the same `create_cctv_import` RPC the web import page uses.
4. Send recordings: each is stitched from its fragments into the working folder (SHA-256 taken as it leaves the card),
   uploaded with the tus resumable protocol into `org/<org>/cctv/<import>/`, and registered with
   `register_cctv_import_video` carrying that hash, so the analysis worker verifies rather than first-anchors it.
5. Optionally acquire an exact image of the whole card (a forensic bit-for-bit copy, empty space included) and inspect it
   as a virtual source. Not needed to send recordings.

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
- `extract_dhfs_recording` — copy one recording out of the volume with the
  proprietary `DHII` header trimmed, DHAV frames or raw H.264/H.265 detected,
  SHA-256 recorded, written atomically and never over existing evidence. With
  `reuseExisting`, a finished copy already in the folder is re-hashed and
  returned instead of refused.
- `default_clip_directory` — the per-card working folder under Public
  Documents, created on demand so the operator never has to pick one.
- `upload_clip_resumable` / `cancel_upload` — tus resumable upload of one
  extracted recording into `bob-uploads` with 6 MiB chunks, per-chunk
  `upload-progress` events, offset resync on transport errors, and an
  `unauthorized` outcome that hands the resumable URL back so the interface can
  refresh the session and continue from the same offset.

The DHFS logic lives in `crates/dhfs` (`fcm-dhfs`), a dependency-light crate
with its own unit tests over synthetic cards (MBR-hidden partition, raw device
start, all-zero partition table with the `0x6c0` superblock fallback, DHII
trim, DHAV frame headers, cyclic/zero-length descriptors). Run them with
`cargo test --manifest-path crates/dhfs/Cargo.toml`; the release workflow runs
them before building the installer.

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
