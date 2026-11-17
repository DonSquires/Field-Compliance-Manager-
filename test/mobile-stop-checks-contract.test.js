const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const panel = read('apps/mobile/src/components/OfficerStopPanel.tsx');
const checks = read('apps/mobile/src/components/OfficerStopChecks.tsx');

test('mobile stops use the officer-authorised stop flow, not the service-only completion RPC', () => {
  assert.doesNotMatch(panel, /complete_shift_stop/);
  assert.doesNotMatch(panel, /from\('shift_stops'\)/);
  assert.match(panel, /rpc\('get_officer_patrol_stops'/);
  assert.match(panel, /rpc\('manage_officer_patrol_stop'/);
  assert.match(panel, /act\(stop, 'depart'\)/);
  assert.match(panel, /p_action: action === 'arrive' \? 'arrive' : 'depart'/);
});

test('mobile departure waits for every check and uses officer-safe errors', () => {
  assert.match(panel, /checksOutstanding\(stop\.checks\)/);
  assert.match(panel, /Record every check first/);
  assert.match(panel, /userFacingError\(/);
});

test('mobile check retries resend the stored request from device storage', () => {
  assert.match(checks, /rpc\('record_patrol_stop_check'/);
  assert.match(checks, /AsyncStorage\.setItem\(/);
  assert.match(checks, /AsyncStorage\.removeItem\(/);
  assert.match(checks, /if \(stored\?\.draftKey === draftKey\) attempt = stored;/);
  assert.match(checks, /Why it could not be completed/);
});

test('mobile stops do not claim an empty shift before the first load or after a failed one', () => {
  assert.match(panel, /const \[loading, setLoading\] = useState\(true\)/);
  assert.match(panel, /!loadError && active\.length === 0/);
});

test('mobile stop polling keeps an action error on screen', () => {
  assert.match(panel, /const \[loadError, setLoadError\]/);
  assert.match(panel, /const \[actionError, setActionError\]/);
  assert.doesNotMatch(panel.slice(panel.indexOf('const load ='), panel.indexOf('useEffect(')), /setActionError/);
});

test('mobile stop controls name the check and meet the touch target', () => {
  assert.match(checks, /accessibilityLabel=\{`\$\{check\.label\}: \$\{outcome === 'done' \? 'Done' : "Couldn't complete"\}`\}/);
  assert.match(checks, /accessibilityLabel=\{`Save \$\{check\.label\}`\}/);
  assert.match(panel, /refresh: \{[^}]*minHeight: 44/);
});
