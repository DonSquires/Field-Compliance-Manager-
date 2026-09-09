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
  assert.equal(packageJson.version, '0.1.49');
  assert.equal(tauri.version, '0.1.49');
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
  assert.match(source, /Pause after step/);
  assert.match(source, /Local H\.265 cache/);
  assert.match(source, /const FCM_WEB_URL = 'https:\/\/fcmanager\.co\.nz'/);
  assert.doesNotMatch(source, /vercel\.app/);
  const adminShell = fs.readFileSync(path.join(root, 'apps/web/src/shells/AdminShell.tsx'), 'utf8');
  assert.match(adminShell, /storage\/v1\/object\/public\/desktop-releases\/0\.1\.44\/FCM-SD-Card-Bridge-Setup\.exe/);
  assert.doesNotMatch(adminShell, /desktop-releases\/FCM-SD-Card-Bridge-Setup\.exe/);
  assert.ok(capability.permissions.includes('opener:default'));
  for (const label of ['Desktop home', 'Import recordings', 'CCTV review', 'Video upload', 'FCM web portal']) {
    assert.match(source, new RegExp(label));
  }
  for (const legacyLabel of ['Built-in DHFS', 'Diagnose DHFS', 'Export raw diagnostic']) {
    assert.doesNotMatch(source, new RegExp(legacyLabel));
  }
});
