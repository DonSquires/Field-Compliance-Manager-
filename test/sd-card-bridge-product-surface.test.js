const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'apps/sd-card-bridge/src/main.tsx'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'apps/sd-card-bridge/package.json'), 'utf8'));
const tauri = JSON.parse(fs.readFileSync(path.join(root, 'apps/sd-card-bridge/src-tauri/tauri.conf.json'), 'utf8'));

test('FCM Desktop product surface is versioned and focused on production workflows', () => {
  assert.equal(packageJson.version, '0.1.42');
  assert.equal(tauri.version, '0.1.42');
  assert.match(source, /if \(!signedInAs\)/);
  assert.match(source, /Secure evidence workstation/);
  assert.match(source, /Only authorised users can inspect recordings/);
  assert.match(source, /const FCM_WEB_URL = 'https:\/\/fcmanager\.co\.nz'/);
  assert.doesNotMatch(source, /vercel\.app/);
  for (const label of ['Desktop home', 'Import recordings', 'CCTV review', 'Video upload', 'FCM web portal']) {
    assert.match(source, new RegExp(label));
  }
  for (const legacyLabel of ['Built-in DHFS', 'Diagnose DHFS', 'Export raw diagnostic']) {
    assert.doesNotMatch(source, new RegExp(legacyLabel));
  }
});
