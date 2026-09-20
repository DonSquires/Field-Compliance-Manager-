# FCM Desktop V2

Desktop V2 is the Windows companion the web app links to for Dahua cards, built beside the older `apps/sd-card-bridge`
application. It does not replace or modify Desktop V1: V1 stays the stable bridge for mountable cards and its own release
line; V2 owns the hidden-partition (DHFS) path, local review and the video-files source.

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
- `list_video_files` / `describe_video_files` / `hash_local_file` / `probe_video_file` — the second source, "Video
  files": files the operator picks (the file picker shows files; Windows' folder picker shows folders only, so
  "choose a whole folder" is the alternative) or a whole folder this computer can see (camera exports, downloads,
  synced cloud folders). Files are listed by recorded day, hashed where they lie before sending, and their
  duration / codec / container `creation_time` read from the decoder's banner. The recorded start comes from the
  file name when a recorder wrote one there, else the container's creation time, else an estimate from the
  modified time — the source is shown next to an editable field and recorded in the import manifest
  (`start_time_source`). Listing also classifies each file's `content` from its name and 4 KiB at four offsets
  (never the decoder, never a full read): `video` (a recognised container signature — ISO BMFF, Matroska, AVI,
  ASF, FLV, MPEG-TS/PS, DHAV, Annex B), `unwritten` (a slot the recorder pre-allocated by name and never recorded
  into — Tapo `xxxxxxxx_000000_tpNNNNN.mp4`), `blank` (filler bytes throughout), `unrecognised` (data with no
  known signature; listed for the decoder to judge) or `offline` (a cloud-sync placeholder, not opened so nothing
  is fetched). `unwritten` and `blank` files are set aside: counted and sized, listed only on request, never in
  "Send all".
- `render_thumbnail` — the list's thumbnail: one small JPEG of a file's first key frame, decoded on this
  computer, cached under `<app local data>/previews/thumbs/` against the file's path, size and modified time,
  requested only when a row scrolls into view and at most two at a time. A viewing aid; cleared with the previews.
- `analyze_recording_segments` / `split_recording_segments` — the motion clips a camera wrote back to back into
  one file. `analyze` reads only the MP4 index (`moov`, plus Tapo's `stte` trigger table hidden in the `free`
  box) and returns the segments. Boundaries come first from the `stte` marks — the camera's own trigger list,
  every one of which must land on a key frame or the table is not trusted — and, when there is no such table,
  from key frames whose sample duration the muxer stretched (~0.5 s against ~0.06 s). When the card's own
  index `sys01.bin` sits beside the file (see `crates/decoder/src/tapo.rs`: 80-byte records, one per motion
  event, with slot number, index within the slot and start/end in Unix seconds), and it lists exactly one
  event per mark for that slot, every clip is dated from it (`clockSource: card_index`); otherwise
  `clockNote` says why the times stay lower bounds. `split` cuts the clips with ffmpeg's segment muxer in one
  pass, video copied frame for frame from the key frame that starts each clip, audio copied where MP4 allows
  it and re-encoded to AAC where it does not (Tapo's µ-law), into `Public Documents\fcm-acquisitions\clips\<stem>-<hash>\`,
  hashing every clip and writing `clips.json` so a complete earlier cut is reused rather than redone (bytes and
  hashes reused; timing always from today's analysis). The pure parts (`container_signature`, box walking,
  `parse_stte`, `apply_card_events`, `split_args`, `parse_segment_list`, the `tapo` index parser) live in
  `crates/decoder` with tests; `cargo run --example segments_probe -- <file> <out dir>` runs them against a
  real file with the system ffmpeg.
- `read_pictures` — the JPEGs of a picture-stream extraction, so its review shows the pictures themselves.
- `load_review_state` / `save_review_state` — the operator's working notes for one card or folder (marks, per-day
  and per-recording place, what was sent and to which import), kept on this computer under
  `<app local data>/review-state/<sha256 of the scope>.json`. Scope is the card identity (capacity, first
  descriptor, stamp) or the folder path, so pulling the same card out and back in restores the notes.
- `disk_report` / `remove_local_files` — "Disk on this computer": every file under the working folder with size,
  kind (`video`, `mp4`, `image`, `pictures`, `partial`, `other`) and its matching recording, plus what the app's
  previews and tools hold and how much other cards' working folders take beside it. Removal takes explicit
  paths, canonicalises them, refuses symlinks and anything outside the given roots, and reports per path.

"Review here" (0.4.0) lets the operator preview a recording on the laptop and choose **Send** or **Skip** per
recording; skipped recordings are left out of "Send all". Sending itself is unchanged: the `-r2` original with
its card-side SHA-256 goes to `register_cctv_import_video`. 0.4.1 added the "Video files" source and "Save to
folder" (hashed original + playable MP4 wherever the operator chooses). 0.4.2 marks a saved recording as saved
(and asks before writing a second copy), lets the operator pick video files directly, shows picture-stream
reviews as pictures, and adds **Pop out**: the preview opens in its own window (`index.html?popout=1`, the same
bundle) for a second screen. The workstation window owns every decision; the pop-out mirrors the open review
through events and sends Play / Send / Skip back the same way. The plan for local analysis is
`docs/DESKTOP_LOCAL_PROCESSING_PLAN.md`.

0.4.3 (owner notes 2026-09-20) adds three operator-workflow pieces:

- **Marks.** Each recording carries one colour-coded mark — *Keep* (green), *Review further* (amber),
  *Reviewed* (blue), *Nothing here* (grey) — set from the list, the review pane or the pop-out. Marks are the
  operator's working notes, kept on this computer with the card's review state; the only thing that travels is
  the mark at send time, recorded in the import manifest as `review_mark`. *Reviewed* and *Nothing here* leave
  a recording out of **Send all** (it can still be sent one at a time). A filter bar above the list shows counts
  per mark and narrows the list to one.
- **Place per recording.** Portable covert cameras move; a card can hold days from several places. The client
  organisation is chosen once; a place (and camera label) can then be set for a whole recorded day or for one
  recording, on top of the default the operator picked in the send panel. Sending groups recordings by place:
  one `create_cctv_import` per client / place / camera, each finished with its own manifest, so the console sees
  each place's footage under that place. The send panel lists the places in use.
- **Disk on this computer.** The working folder is grouped by what is safe to remove. Offered for removal:
  copies FCM has verified (the row's `storage_path` exists in `evidence_items` with
  `metadata.integrity.state = 'verified'`), recordings marked *Nothing here* or *Reviewed* that were never
  sent, and stray `.part` files from interrupted extractions. Never offered: *Keep* and *Review further*,
  undecided recordings, anything sent but not yet verified by FCM (or with a hash mismatch — the row says so),
  and copies the operator saved on purpose with "Save to folder". Removal always asks first, is bounded to the
  working folder by the native side, and the review state forgets only what was actually removed.

0.4.4 (owner field notes 2026-09-20, Tapo card: 915 files, 228 GB, two real recordings) sets aside the files
that hold no recording and puts a thumbnail on each file row. A Tapo camera fills its card with 256 MB
placeholder slots named `xxxxxxxx_000000_tpNNNNN.mp4` and renames one to its start time only when it records
into it; the list showed all 915 as video files with meaningless "last written" start times. Now the listing
classifies each file's content (see `list_video_files` above): unwritten slots and blank files are counted and
sized in the facts ("Set aside 913 unwritten or blank · 228.2 GB") but not listed, not counted as video files
and never part of "Send all"; "Show" lists them, greyed with a badge, so the operator can check one and send it
on its own if they must. Files with no recognised header stay listed with an amber badge for the decoder to
judge; cloud-only placeholders are never opened during listing. Each listed file row carries a thumbnail of
its first key frame (decoder required), loaded as rows scroll into view.

0.4.5 (owner field notes 2026-09-20: "this one shows 23 minutes but it has multiple motion activations on
separate time frames") cuts such a file into **selectable clips, each its own file**. Verified on the operator's
real Tapo recording: one 256 MB slot held 71 motion clips (76 camera triggers in Tapo's own table), the
presentation clock running on continuously across them. When a listed MP4's index shows more than one clip,
the row offers "N motion clips · Split"; the clips then appear under the file as rows of their own —
thumbnail, mark, place, preview, send — and the whole file drops out of "Send all" (it can still be sent on
its own, or the split undone while no clip has been sent). Every clip carries its own SHA-256, checked against
the bytes on disk again before sending; the manifest records the source file, segment index, planned and
actual cut times, method and audio handling. **Timing is a lower bound and is shown as one (≥ 14:36:11):**
the camera pauses between motion events and nothing in the file records those gaps — only the clock burnt
into the picture does. Reading that clock is the next step, not assumed.

0.4.6 (owner supplied the whole card folder, 2026-09-20) dates every clip from the **camera's own card index**.
Beside the slot files a Tapo card carries `sys01.bin`: one 80-byte record per motion event with the slot
number, the event's index within the slot and its start and end in Unix seconds. Event *i* of a slot is the
*i*th `stte` mark of that slot's file, so the two together date each clip; the first clip of a slot carries a
few seconds of pre-roll before its trigger, which the first mark states. Verified on the real card against the
clock burnt into the picture, to the second, on eight clips across both recorded slots — including slot 0,
which turned out to span **four days** (its first 71 clips on 11 Sep, the last five on 15 Sep, a fact the
0.4.5 lower bounds could not show). Boundaries now come from the `stte` marks themselves (76 clips, not 71:
five restarts had no stretched frame), with the stretched-frame rule kept as the fallback for files without a
table. In the list a dated clip shows a plain time (with its date when it differs from the file's day); an
undated clip keeps the `≥` lower bound and the chip's tooltip says what is missing ("No card index (sys01.bin)
beside this file … copy the whole card folder, index files included"). The manifest records
`start_time_source: camera_card_index` with `camera_event_start_at` / `camera_event_end_at`, or
`segment_offset_lower_bound` as before. A correction typed into the parent file's start moves only undated
clips — the operator's guess does not outrank the camera's record. Copying a Tapo card: copy the **whole
folder** (the `xxxxxxxx_000000_tp…` placeholders can be skipped, `sys01.bin` cannot).

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
