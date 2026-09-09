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
  assert.match(source, /Discover removable media/);
  assert.match(source, /Acquire exact image/);
  assert.match(source, /Inspect image and map partitions/);
  assert.match(source, /Prototype only\. V1 remains the working field bridge\./);
  assert.match(native, /OpenOptions::new\(\)\.read\(true\)\.write\(false\)/);
  assert.match(native, /acquire_read_only_device_image/);
  assert.match(entrypoint, /fcm_sd_card_bridge_v2_lib::run/);
  assert.match(native, /source_sha256/);
  assert.match(native, /image_sha256/);
  assert.match(native, /verified/);
  assert.match(native, /preserve for broader forensic scan/);
  assert.match(native, /create_new\(true\)/);
  assert.match(native, /with_extension\("img\.part"\)/);
  assert.match(native, /Could not commit verified image atomically/);
  assert.match(readme, /does not replace or modify Desktop V1/);
  assert.match(workflow, /FCM-Desktop-V2-Setup\.exe/);
  assert.match(workflow, /Build unsigned development installer/);
  assert.match(workflow, /SmartScreen/);
});
