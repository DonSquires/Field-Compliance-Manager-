const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');

const safety = readFileSync(resolve(__dirname, '../apps/mobile/src/lib/officerSafety.ts'), 'utf8');
const bar = readFileSync(resolve(__dirname, '../apps/mobile/src/components/OfficerSafetyBar.tsx'), 'utf8');
const briefing = readFileSync(resolve(__dirname, '../apps/mobile/src/components/OfficerSafetyBriefing.tsx'), 'utf8');
const clock = readFileSync(resolve(__dirname, '../apps/mobile/src/components/OfficerShiftClockPanel.tsx'), 'utf8');
const mobileScreen = readFileSync(resolve(__dirname, '../apps/mobile/src/components/OfficerScanScreen.tsx'), 'utf8');
const mobileApp = readFileSync(resolve(__dirname, '../apps/mobile/App.tsx'), 'utf8');
const mobileStops = readFileSync(resolve(__dirname, '../apps/mobile/src/components/OfficerStopPanel.tsx'), 'utf8');

test('mobile welfare writes go through governed RPCs and check every response', () => {
  assert.match(safety, /supabase\.rpc\('record_officer_welfare_checkin'/);
  assert.match(safety, /supabase\.rpc\('raise_officer_sos'/);
  assert.match(safety, /p_client_request_id: crypto\.randomUUID\(\)/);
  assert.doesNotMatch(safety, /from\('welfare_checks'\)/);
  assert.doesNotMatch(safety, /from\('officer_welfare_settings'\)/);
  assert.doesNotMatch(safety, /from\('welfare_alerts'\)/);
  assert.match(safety, /if \(error\) throw error/);
});

test('mobile safety bar confirms SOS and never presents failed writes as confirmed', () => {
  assert.match(bar, /Alert\.alert\('Trigger SOS\?'/);
  assert.match(bar, /'SOS not confirmed'/);
  assert.match(bar, /'Check-in not confirmed'/);
  assert.match(bar, /'SOS confirmed\. Supervisors have been alerted\.'/);
});

test('native shift clock checks place risks before starting and supports governed reports and source links', () => {
  assert.match(clock, /<OfficerSafetyBriefing/);
  assert.match(mobileApp, /shiftServiceType=\{fieldContext\.assignment\?\.serviceType \?\? null\}/);
  assert.match(mobileScreen, /shiftServiceType=\{shiftServiceType\}/);
  assert.match(clock, /shiftServiceType=\{shiftServiceType\}/);
  assert.match(briefing, /fetchMobileShiftSafety/);
  assert.match(briefing, /functions\.invoke\('officer-shift-briefing'/);
  assert.match(briefing, /rpc\('get_shift_safety_briefing'/);
  assert.match(briefing, /if \(next\.item_count > 0 && !next\.acknowledged\)/);
  assert.match(briefing, /rpc\('acknowledge_safety_briefing'/);
  assert.match(briefing, /data\.briefing_hash !== briefing\.briefing_hash/);
  assert.match(briefing, /failure\?\.hint === 'briefing_changed'/);
  assert.match(briefing, /rpc\('report_place_hazard'/);
  assert.match(briefing, /functions\.invoke\('place-hazard-source'/);
  assert.doesNotMatch(briefing, /from\('(?:place_hazards|safety_briefing_acknowledgements)'\)/);
  assert.doesNotMatch(mobileStops, /\.select\('[^']*officer_notes/);
});