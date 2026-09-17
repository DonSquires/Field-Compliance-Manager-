const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'apps/sd-card-bridge/src/main.tsx'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'apps/sd-card-bridge/package.json'), 'utf8'));
const tauri = JSON.parse(fs.readFileSync(path.join(root, 'apps/sd-card-bridge/src-tauri/tauri.conf.json'), 'utf8'));
const capability = JSON.parse(fs.readFileSync(path.join(root, 'apps/sd-card-bridge/src-tauri/capabilities/default.json'), 'utf8'));

test('FCM Desktop product surface is versioned and focused on production workflows', () => {
  assert.equal(packageJson.version, '0.1.53');
  assert.equal(tauri.version, '0.1.53');
  assert.match(source, /if \(!signedInAs\)/);
  assert.match(source, /Secure evidence workstation/);
  assert.match(source, /Only authorised users can inspect recordings/);
  assert.match(source, /openUrl/);
  assert.doesNotMatch(source, /target="_blank"/);
  assert.match(source, /activeView === 'cctv-review'/);
  assert.match(source, /Copy review link/);
  assert.match(source, /Analyse SD card and process all clips/);
  assert.match(source, /Process all SD recordings/);
  assert.match(source, /Codec was not classified locally/);
  assert.match(source, /autoRemainingSeconds/);
  assert.match(source, /Elapsed/);
  assert.match(source, /Clip/);
  assert.match(source, /Queued/);
  assert.match(source, /Needs retry/);
  assert.match(source, /MAX_AUTO_CLIP_ATTEMPTS/);
  assert.match(source, /Recordings needing retry/);
  assert.match(source, /Last error/);
  assert.match(source, /Registration retry/);
  assert.match(source, /if \(!preserveCachedClip\)/);
  assert.match(source, /source_index_sha256/);
  assert.match(source, /source_record_number/);
  assert.match(source, /sourceIndexRecord/);
  assert.match(source, /Pause after step/);
  assert.match(source, /Local H\.265 cache/);
  assert.match(source, /const FCM_WEB_URL = 'https:\/\/fcmanager\.co\.nz'/);
  assert.doesNotMatch(source, /vercel\.app/);
  const adminShell = fs.readFileSync(path.join(root, 'apps/web/src/shells/AdminShell.tsx'), 'utf8');
  assert.match(adminShell, /releases\/download\/sd-card-bridge-v0\.1\.53\/FCM-SD-Card-Bridge-Setup\.exe/);
  // The web app's V2 download must follow the V2 build it advertises: a stale pin here shipped the blank 0.1.3 window
  // to an operator twice (2026-09-17) while 0.1.4/0.1.5 sat unused on the releases page.
  const v2Package = JSON.parse(fs.readFileSync(path.join(root, 'apps/sd-card-bridge-v2/package.json'), 'utf8'));
  const v2Tauri = JSON.parse(fs.readFileSync(path.join(root, 'apps/sd-card-bridge-v2/src-tauri/tauri.conf.json'), 'utf8'));
  assert.equal(v2Tauri.version, v2Package.version);
  assert.match(adminShell, new RegExp(`const DESKTOP_V2_VERSION = '${v2Package.version.replace(/\./g, '\\.')}';`));
  // FCM roles do not grant GitHub auth: V2 is served from the public desktop-releases bucket.
  assert.match(adminShell, /storage\/v1\/object\/public\/desktop-releases\/v2\/\$\{DESKTOP_V2_VERSION\}\/FCM-Desktop-V2-Setup\.exe/);
  assert.match(adminShell, /FCM Desktop V2 · v\{DESKTOP_V2_VERSION\}/);
  assert.match(adminShell, /unsigned development build/);
  assert.ok(capability.permissions.includes('opener:default'));
  for (const label of ['Desktop home', 'One-shot SD import', 'Review in web portal', 'Upload exported video', 'FCM web portal']) {
    assert.match(source, new RegExp(label));
  }
  for (const legacyLabel of ['Built-in DHFS', 'Diagnose DHFS', 'Export raw diagnostic']) {
    assert.doesNotMatch(source, new RegExp(legacyLabel));
  }
});
