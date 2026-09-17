const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'apps/sd-card-bridge-v2/src/main.tsx'), 'utf8');
const native = fs.readFileSync(path.join(root, 'apps/sd-card-bridge-v2/src-tauri/src/lib.rs'), 'utf8');
const entrypoint = fs.readFileSync(path.join(root, 'apps/sd-card-bridge-v2/src-tauri/src/main.rs'), 'utf8');
const readme = fs.readFileSync(path.join(root, 'apps/sd-card-bridge-v2/README.md'), 'utf8');
const workflow = fs.readFileSync(path.join(root, '.github/workflows/release-sd-card-bridge-v2.yml'), 'utf8');

test('Desktop V2 preserves V1 and implements clone-first acquisition boundaries', () => {
  assert.match(source, /Clone first\. Decode second\./);
  assert.match(source, /Discover camera cards and disks/);
  assert.match(source, /Acquire exact image/);
  assert.match(source, /Inspect image and map partitions/);
  assert.match(source, /Prototype only\. V1 remains the working field bridge\./);
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
  assert.match(readme, /does not replace or modify Desktop V1/);
  assert.match(workflow, /FCM-Desktop-V2-Setup\.exe/);
  assert.match(workflow, /Build unsigned development installer/);
  assert.match(workflow, /SmartScreen/);
  assert.match(workflow, /Reuse the approved FCM desktop icon set/);
});

const dhfs = fs.readFileSync(path.join(root, 'apps/sd-card-bridge-v2/crates/dhfs/src/lib.rs'), 'utf8');
const cargo = fs.readFileSync(path.join(root, 'apps/sd-card-bridge-v2/src-tauri/Cargo.toml'), 'utf8');

test('Desktop V2 actually mounts its React app', () => {
  // The first prototype exported App without rendering it: the installed window was blank.
  assert.match(source, /createRoot\(root\)\.render\(<StrictMode><App \/><\/StrictMode>\)/);
  assert.match(source, /document\.getElementById\('root'\)/);
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
  assert.match(cargo, /features = \["devtools"\]/);
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
});

test('Desktop V2 exposes catalog + extraction to the UI from either the image or the card, read-only', () => {
  for (const command of ['discover_read_only_devices', 'acquire_read_only_device_image', 'inspect_acquisition_image', 'read_dhfs_catalog', 'extract_dhfs_recording']) {
    assert.match(native, new RegExp(`fn ${command}\\(`), `${command} is defined`);
    assert.match(native, new RegExp(`generate_handler!\\[[^\\]]*${command}`), `${command} is registered`);
    assert.match(source, new RegExp(`invoke<[^>]+>\\('${command}'`), `${command} is invoked by the UI`);
  }
  // Serialised structs are camelCase so the TypeScript types are actually populated (the prototype's were not).
  assert.match(native, /#\[serde\(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase"\)\]\nenum DhfsSourceSpec/);
  assert.equal((native.match(/#\[serde\(rename_all = "camelCase"\)\]/g) || []).length >= 4, true);
  assert.match(native, /Device \{ id, size_bytes \} => \{\n\s+if !is_physical_drive_id\(id\)/);
  assert.match(native, /AlignedFileSource::from_file\(file, Some\(\*size_bytes\), DEVICE_READ_ALIGNMENT\)/);
  assert.match(source, /List recordings directly from card/);
  assert.match(source, /readCatalog\(\{ kind: 'device', id: selectedDevice\.id, sizeBytes: selectedDevice\.sizeBytes \}\)/);
  assert.match(source, /if \(result\.dhfs\) await readCatalog\(\{ kind: 'image', path: receipt\.imagePath \}\)/);
  assert.match(source, /invoke<ExtractedClip>\('extract_dhfs_recording', \{ source: catalogSource, partitionIndex: recording\.partitionIndex, descriptor: recording\.descriptor, destinationDirectory: directory \}\)/);
  assert.match(workflow, /cargo test --manifest-path crates\/dhfs\/Cargo\.toml/);
});
