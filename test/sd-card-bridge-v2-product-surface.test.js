const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'apps/sd-card-bridge-v2/src/main.tsx'), 'utf8');
const native = fs.readFileSync(path.join(root, 'apps/sd-card-bridge-v2/src-tauri/src/lib.rs'), 'utf8');
const entrypoint = fs.readFileSync(path.join(root, 'apps/sd-card-bridge-v2/src-tauri/src/main.rs'), 'utf8');
const readme = fs.readFileSync(path.join(root, 'apps/sd-card-bridge-v2/README.md'), 'utf8');
const signer = fs.readFileSync(path.join(root, 'scripts/desktop-signing/sign-and-publish.mjs'), 'utf8');
const photoMigration = fs.readFileSync(path.join(root, 'supabase/migrations/20260926012000_cctv_photo_inference.sql'), 'utf8');
const dedupeMigration = fs.readFileSync(path.join(root, 'supabase/migrations/20260927290000_cctv_media_hash_dedupe.sql'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'apps/sd-card-bridge-v2/src/styles.css'), 'utf8');

test('Desktop V2 is the operating desktop and keeps its read-only, card-first boundaries', () => {
  // 0.2.0 ruling: the card is the drive. Recordings are read straight from the hidden partition; the exact image is optional.
  assert.match(source, /Read the card\. Send the recordings\./);
  assert.match(source, /Discover camera cards and disks/);
  assert.match(source, /List recordings directly from card/);
  assert.match(source, /Acquire exact image/);
  assert.match(source, /Inspect image and map partitions/);
  assert.match(source, /Optional forensic copy/);
  assert.match(native, /OpenOptions::new\(\)\.read\(true\)\.write\(false\)/);
  assert.match(native, /acquire_read_only_device_image/);
  assert.match(entrypoint, /fcm_sd_card_bridge_v2_lib::run/);
  assert.match(native, /source_sha256/);
  assert.match(native, /image_sha256/);
  assert.match(native, /verified/);
  assert.match(native, /Candidate offsets preserved for codec-specific inspection/);
  assert.match(native, /create_new\(true\)/);
  assert.match(native, /with_extension\("img\.part"\)/);
  assert.match(native, /Could not commit verified image atomically/);
  assert.match(readme, /operating Windows companion/);
  assert.match(signer, /\['rev-parse', `\$\{TAG\}\^\{commit\}`\]/);
  assert.match(signer, /'--prerelease=false', '--latest'/);
  for (const icon of ['32x32.png', '128x128.png', '128x128@2x.png', 'icon.ico']) {
    assert.equal(fs.existsSync(path.join(root, 'apps/sd-card-bridge-v2/src-tauri/icons', icon)), true, `${icon} is owned by V2`);
  }
});

const dhfs = fs.readFileSync(path.join(root, 'apps/sd-card-bridge-v2/crates/dhfs/src/lib.rs'), 'utf8');
const cargo = fs.readFileSync(path.join(root, 'apps/sd-card-bridge-v2/src-tauri/Cargo.toml'), 'utf8');

test('Desktop V2 actually mounts its React app', () => {
  // The first prototype exported App without rendering it: the installed window was blank.
  assert.match(source, /createRoot\(root\)\.render\(<StrictMode>\{IS_POPOUT \? <PopoutViewer \/> : <App \/>\}<\/StrictMode>\)/);
  assert.match(source, /document\.getElementById\('root'\)/);
  // The pop-out preview is the same bundle in a second window; only the workstation decides, the viewer reports.
  assert.match(source, /const IS_POPOUT = new URLSearchParams\(window\.location\.search\)\.get\('popout'\) === '1';/);
  assert.match(source, /new WebviewWindow\(POPOUT_LABEL, \{ url: 'index\.html\?popout=1'/);
  assert.match(source, /emitTo\('main', POPOUT_ACTION_EVENT/);
});

const indexHtml = fs.readFileSync(path.join(root, 'apps/sd-card-bridge-v2/index.html'), 'utf8');
const v2Package = JSON.parse(fs.readFileSync(path.join(root, 'apps/sd-card-bridge-v2/package.json'), 'utf8'));
const v2Tauri = JSON.parse(fs.readFileSync(path.join(root, 'apps/sd-card-bridge-v2/src-tauri/tauri.conf.json'), 'utf8'));

test('Desktop V2 can never open to a silent blank window and always says which build it is', () => {
  // 0.1.3 shipped blank and every installer reported 0.1.0: the operator could not tell builds apart.
  assert.equal(v2Tauri.version, v2Package.version);
  assert.match(cargo, new RegExp(`^version = "${v2Package.version.replace(/\./g, '\\.')}"`, 'm'));
  assert.match(source, /Desktop V2 · v\{APP_VERSION\}/);
  assert.match(indexHtml, /FCM Desktop V2 · build __APP_VERSION__/);
  assert.match(indexHtml, /id="boot-error"/);
  assert.match(indexHtml, /window\.addEventListener\('error'/);
  assert.match(indexHtml, /window\.addEventListener\('unhandledrejection'/);
  assert.match(indexHtml, /did not mount within 8 seconds/);
  // devtools stays on for field diagnosis; protocol-asset exists only so the in-app player can read the previews folder.
  assert.match(cargo, /features = \["devtools", "protocol-asset"\]/);
  assert.deepEqual(v2Tauri.app.security.assetProtocol, { enable: true, scope: ['$APPLOCALDATA/previews/**'] });
});

test('Desktop V2 finds the card behind a drive letter and can describe an unrecognised one', () => {
  // Bus-type filtering hid cards in built-in readers; the operator knows the card as "D:", not as a PhysicalDrive.
  assert.match(native, /Get-Disk \| Where-Object \{ -not \$_\.IsBoot -and -not \$_\.IsSystem \}/);
  assert.match(native, /Get-Partition -DiskNumber/);
  assert.match(native, /drive_letters: Vec<String>/);
  assert.match(native, /fn probe_device\(id: String, size_bytes: u64\)/);
  assert.match(native, /sector0_hex/);
  assert.match(native, /fn explain_device_error/);
  assert.match(native, /Run as administrator/);
  assert.match(source, /Probe first sectors/);
  assert.match(source, /if \(device\) await probeDevice\(device\);/);
  assert.match(source, /device\.driveLetters\.join\(' '\)/);
});

const capability = JSON.parse(fs.readFileSync(path.join(root, 'apps/sd-card-bridge-v2/src-tauri/capabilities/default.json'), 'utf8'));

test('Desktop V2 acquisition cannot fail silently and keeps the window alive for a 128 GB clone', () => {
  // Without a capability the save dialog was refused and the rejection vanished: "Acquire" did nothing.
  assert.deepEqual(capability.windows, ['main', 'preview']);
  assert.ok(capability.permissions.includes('core:default'));
  assert.ok(capability.permissions.includes('dialog:default'));
  assert.ok(capability.permissions.includes('core:webview:allow-create-webview-window'));
  assert.match(source, /try \{\s*destination = await save\(/);
  assert.match(source, /window\.addEventListener\('unhandledrejection', onRejection\)/);
  // The clone runs off the main thread and reports progress; a sync command froze the window for the whole copy.
  assert.match(native, /#\[tauri::command\(async\)\]\s*fn acquire_read_only_device_image\(app: tauri::AppHandle, source_id: String, destination_path: String, size_bytes: u64\)/);
  assert.match(native, /app\.emit\("acquisition-progress"/);
  assert.match(native, /fn cancel_acquisition\(\)/);
  assert.match(native, /fs2::available_space/);
  assert.match(native, /fn is_end_of_device/);
  for (const command of ['discover_read_only_devices', 'probe_device', 'inspect_acquisition_image', 'read_dhfs_catalog', 'extract_dhfs_recording']) {
    assert.match(native, new RegExp(`#\\[tauri::command\\(async\\)\\]\\s*fn ${command}\\(`), `${command} must run off the main thread`);
  }
  assert.match(source, /listen<AcquisitionProgress>\('acquisition-progress'/);
  assert.match(source, /invoke\('cancel_acquisition'\)/);
  assert.match(source, /role="progressbar"/);
  assert.match(source, /sizeBytes: selectedDevice\.sizeBytes \}\)/);
});

test('Desktop V2 reads the hidden DHFS partition through the shared fcm-dhfs crate', () => {
  assert.match(cargo, /fcm-dhfs = \{ path = "\.\.\/crates\/dhfs" \}/);
  // Locate: sector 0, MBR/GPT partition starts, then a bounded sector scan — never "not found" because Windows shows RAW.
  assert.match(dhfs, /pub fn locate_volume/);
  assert.match(dhfs, /LocationMethod::DeviceStart/);
  assert.match(dhfs, /LocationMethod::MbrPartition/);
  assert.match(dhfs, /LocationMethod::GptPartition/);
  assert.match(dhfs, /LocationMethod::Scan/);
  // Layout rules proven on real cards by V1: DPT marker, not a fixed 0x3c00; single-partition superblock fallback.
  assert.match(dhfs, /pub const DPT_MARKER: &\[u8; 9\] = b"DHFS_DPT:";/);
  assert.match(dhfs, /pub const SINGLE_PARTITION_SUPERBLOCK_OFFSET: u64 = 0x6c0;/);
  assert.match(dhfs, /pub const DEVICE_READ_ALIGNMENT: u64 = 4096;/);
  // Descriptor walk: main descriptors only, chains followed, broken ones reported instead of dropped silently.
  assert.match(dhfs, /if descriptor\.kind\(\) != 1 \{ return Ok\(None\); \}/);
  assert.match(dhfs, /fragment chain is cyclic/);
  assert.match(dhfs, /skipped_descriptors/);
  // Streams: DHII header trimmed, DHAV container recognised (FFmpeg dhav.c layout), ES parameter sets detected.
  assert.match(dhfs, /pub fn dhav_frame_header/);
  assert.match(dhfs, /has_dhii_header/);
  assert.match(dhfs, /StreamKind::ElementaryH265/);
  // Extraction is atomic and never overwrites evidence.
  assert.match(dhfs, /create_new\(true\)/);
  assert.match(dhfs, /existing evidence is never overwritten/);
  assert.match(dhfs, /sync_all\(\)/);
  // A card that has lost its opening sectors still gets read: V1 could start from a known offset, V2 must too.
  assert.doesNotMatch(dhfs, /let sector0 = read_vec\(source, 0, SECTOR as usize\)\?;/);
  assert.match(dhfs, /sector 0 could not be read/);
  assert.match(dhfs, /const MAX_UNREADABLE_SCAN/);
  assert.match(dhfs, /const SCAN_RETRY_CHUNK/);
});

test('Desktop V2 exposes catalog + extraction to the UI from either the image or the card, read-only', () => {
  for (const command of ['discover_read_only_devices', 'acquire_read_only_device_image', 'inspect_acquisition_image', 'read_dhfs_catalog', 'extract_dhfs_recording']) {
    assert.match(native, new RegExp(`fn ${command}\\(`), `${command} is defined`);
    assert.match(native, new RegExp(`generate_handler!\\[[^\\]]*${command}`), `${command} is registered`);
    assert.match(source, new RegExp(`invoke<[^>]+>\\('${command}'`), `${command} is invoked by the UI`);
  }
  // Serialised structs are camelCase so the TypeScript types are actually populated (the prototype's were not).
  assert.match(native, /#\[serde\(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase"\)\]\r?\nenum DhfsSourceSpec/);
  assert.equal((native.match(/#\[serde\(rename_all = "camelCase"\)\]/g) || []).length >= 4, true);
  assert.match(native, /Device \{ id, size_bytes \} => \{\r?\n\s+if !is_physical_drive_id\(id\)/);
  assert.match(native, /AlignedFileSource::from_file\(file, Some\(\*size_bytes\), DEVICE_READ_ALIGNMENT\)/);
  assert.match(source, /List recordings directly from card/);
  assert.match(source, /readCatalog\(\{ kind: 'device', id: selectedDevice\.id, sizeBytes: selectedDevice\.sizeBytes \}\)/);
  assert.match(source, /if \(result\.dhfs\) await readCatalog\(\{ kind: 'image', path: receipt\.imagePath \}\)/);
  // A reader or card that answers with an I/O error is named as such, not left as a bare Windows sentence.
  assert.match(native, /Some\(1117\) \| Some\(23\) =>/);
  assert.match(native, /fn explain_card_read_failure/);
  assert.match(native, /read_at\(&mut source, 0, &mut sector0\)\.map_err\(\|error\| explain_card_read_failure/);
  assert.match(native, /if from_card \{ explain_card_read_failure\(error\.to_string\(\)\) \}/);
  // Every extraction reuses a finished copy rather than refusing or duplicating it; the operator chooses the folder.
  assert.match(source, /invoke<ExtractedClip>\('extract_dhfs_recording', \{ source: catalogSource, partitionIndex: recording\.partitionIndex, descriptor: recording\.descriptor, destinationDirectory: chosen, reuseExisting: true \}\)/);
  assert.match(source, /invoke<ExtractedClip>\('extract_dhfs_recording', \{ source: catalogSource, partitionIndex: recording\.partitionIndex, descriptor: recording\.descriptor, destinationDirectory: directory, reuseExisting: true \}\)/);
});

test('Desktop V2 sends ordinary and card-extracted photos through governed face and plate inference', () => {
  assert.match(native, /const PHOTO_EXTENSIONS: \[&str; 7\]/);
  assert.match(native, /return if image \{ \("image", Some\("image"\)\) \}/);
  assert.match(source, /type FileContent = 'video' \| 'image'/);
  assert.match(source, /const isPhotoFile = \(file: LocalVideoFile\) => file\.content === 'image' \|\| PHOTO_FILE_EXTENSIONS\.includes/);
  assert.match(source, /kind: photo \? 'local_photo' : 'local_video'/);
  assert.match(source, /if \(item\.kind === 'file' && isPhotoFile\(item\.file\)\)/);
  assert.match(source, /<img src=\{`data:\$\{frame\.mimeType/);
  assert.equal((source.match(/supabase\.rpc\('register_cctv_import_photo'/g) || []).length, 2, 'ordinary photos and card picture streams use the photo RPC');
  assert.match(source, /p_capture_time_source: 'camera_index'/);
  assert.match(source, /queued for provisional face and plate recognition/);
  assert.match(photoMigration, /evidence_kind, storage_path[\s\S]*'photo'/);
  assert.match(photoMigration, /'video_motion', 'queued'/);
});

test('Desktop V2 keeps review navigation visible, uses inspectable thumbnails, and deduplicates before review and upload', () => {
  assert.match(styles, /\.media-day-timeline\{position:sticky;top:0;z-index:25/);
  assert.match(styles, /\.recording__thumb\{width:192px/);
  assert.match(styles, /\.recording__thumb\{width:144px\}/);
  assert.match(source, /if \(isOpen\) return photo \? 'Close photo' : 'Close video preview'/);
  assert.match(source, /return photo \? 'View photo' : 'Preview video'/);
  assert.equal((source.match(/reviewActionLabel\(item, isOpen, reviewState\)/g) || []).length, 3, 'clip, card and file rows use media-specific review labels');
  assert.match(source, /supabase\.rpc\('find_existing_cctv_media_by_hash'/);
  assert.match(source, /supabase\.rpc\('prepare_cctv_media_upload'/);
  assert.match(source, /p_status: anySent \? 'registered' : 'draft'/);
  assert.match(dedupeMigration, /UNIQUE\(organization_id,evidence_kind,sha256\)/);
  assert.match(dedupeMigration, /pg_advisory_xact_lock/);
  assert.match(dedupeMigration, /status='uploading' AND import\.video_count=0 AND import\.snapshot_count=0/);
});

test('Desktop V2 selects canonical Sites and Zones and offers direct day/clip timeline navigation', () => {
  assert.match(source, /supabase\.from\('client_sites'\)/);
  assert.match(source, /supabase\.from\('location_zones'\)/);
  assert.match(source, /p_site_id: place\.siteId \?\? null, p_zone_id: place\.zoneId \?\? null/);
  assert.match(source, /className="media-day-timeline"/);
  assert.match(source, /weekday === 'Saturday' \|\| weekday === 'Sunday'/);
  assert.match(source, /jumpToTimelineItem\(entry\.key\)/);
  assert.match(source, /clipKey\(file, cut\.index\)/);
});

const decoder = fs.readFileSync(path.join(root, 'apps/sd-card-bridge-v2/crates/decoder/src/lib.rs'), 'utf8');

test('Desktop V2 "Review here" trusts the decoder by hash only and never treats a preview as evidence', () => {
  // The sidecar is pinned: version, byte size and SHA-256 of both the binary and its licence are compiled in.
  assert.match(decoder, /pub const FFMPEG_SHA256: &str = "[0-9a-f]{64}";/);
  assert.match(decoder, /pub const LICENSE_SHA256: &str = "[0-9a-f]{64}";/);
  assert.match(decoder, /win64-lgpl/);
  // Every use re-hashes the installed file; a swapped binary is refused, not run.
  assert.match(native, /fn verified_ffmpeg\(app: &tauri::AppHandle\)/);
  assert.match(native, /if digest != fcm_decoder::FFMPEG_SHA256 \{ return Err\(/);
  assert.match(native, /The downloaded file's hash .* does not match the pinned build\. It was discarded; nothing was installed\./);
  // Previews live under the app's own data folder and are never uploaded or registered.
  assert.match(native, /Never uploaded, never registered: the evidence is the extracted original\./);
  assert.match(native, /app_local_data\(&app\)\?\.join\("previews"\)/);
  assert.doesNotMatch(source, /upload_clip_resumable'[^\n]*preview\.path/);
  assert.match(source, /viewing copy only, never sent/);
  // Sending is unchanged: the extracted original goes up with the hash taken from the card.
  assert.match(source, /supabase\.rpc\('register_cctv_import_video', \{[^}]*p_sha256: clip\.sha256/);
  for (const command of ['decoder_status', 'install_decoder', 'render_filmstrip', 'render_preview', 'clear_previews', 'export_mp4']) {
    assert.match(native, new RegExp(`#\\[tauri::command\\(async\\)\\]\\s*fn ${command}\\(`), `${command} runs off the main thread`);
    assert.match(native, new RegExp(`generate_handler!\\[[^\\]]*${command}`), `${command} is registered`);
  }
});
