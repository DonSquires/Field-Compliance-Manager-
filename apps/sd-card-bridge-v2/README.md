# FCM Desktop V2 Prototype

Desktop V2 is an isolated prototype beside the working `apps/sd-card-bridge` application.

## Purpose

V2 tests a clone-first evidence workflow:

1. Discover removable camera media without opening a write handle.
2. Acquire an exact image to a separate destination.
3. Hash source and image bytes and verify equality.
4. Inspect the image as a virtual source.
5. Run multiple decoder adapters without rejecting unknown layouts.

The prototype does not replace or modify Desktop V1.

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
  SHA-256 recorded, written atomically and never over existing evidence.

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
