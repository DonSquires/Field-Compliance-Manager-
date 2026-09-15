const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

// GEOFENCE_PRINCIPLES P1: "no geofence", "unverified", "invalid" and "outside all
// geofences" are four different answers. Callers must branch on resolution_status;
// a false/NULL is never an answer. This audits the runtime callers named in canon.

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const scan = read('supabase/functions/process-officer-scan/index.ts');
const scanShell = read('apps/web/src/shells/ScanShell.tsx');
const mobileScan = read('apps/mobile/src/lib/officerScan.ts');
const mobileScreen = read('apps/mobile/src/components/OfficerScanScreen.tsx');
const relationships = read('apps/web/src/context/ServiceRelationshipContext.tsx');
const schema = read('supabase/schema.sql');

const OUTCOMES = ['resolved', 'outside_all_geofences', 'unresolved_no_geofence', 'unresolved_unverified', 'unresolved_invalid'];

test('the resolver contract exposes resolution_status and governor_overlap_flag to every caller', () => {
  for (const fn of ['resolve_context', 'resolve_context_authorized', 'resolve_operational_context']) {
    const start = schema.indexOf(`CREATE OR REPLACE FUNCTION "public"."${fn}"(`);
    assert.ok(start > 0, `${fn} must exist live`);
    const signature = schema.slice(start, schema.indexOf('LANGUAGE', start));
    assert.match(signature, /resolution_status text/, `${fn} must return resolution_status`);
    assert.match(signature, /governor_overlap_flag boolean/, `${fn} must return governor_overlap_flag`);
  }
});

test('the scan pipeline reads the status, fails closed on an absent row, and never collapses outcomes into "no zone"', () => {
  assert.match(scan, /resolutionStatus = typeof ctx\.resolution_status === 'string' && ctx\.resolution_status \? ctx\.resolution_status : 'unresolved_no_geofence'/);
  assert.match(scan, /governorOverlapFlag = ctx\.governor_overlap_flag === true/);
  assert.match(scan, /if \(!ctx\) return json\(\{ error: 'Geofence context could not be resolved', detail: 'resolver returned no row' \}, 503\)/);
  assert.match(scan, /resolutionStatus !== 'resolved' && \(zoneId \|\| siteId\)[\s\S]*?503/);
  assert.match(scan, /let resolutionStatus = manualZoneId \? 'resolved' : hasLatitude && hasLongitude \? null : 'not_evaluated'/);
  assert.doesNotMatch(scan, /if \(ctx\) \{\s*zoneId = ctx\.matched_zone_id/, 'an absent resolver row must not be silently tolerated');
});

test('every outcome has its own loud notice and the status is persisted with the observation and returned to the officer', () => {
  const notice = scan.slice(scan.indexOf('const GEOFENCE_NOTICE = {'), scan.indexOf('};', scan.indexOf('const GEOFENCE_NOTICE = {')));
  assert.match(notice, /resolved: null/);
  for (const outcome of OUTCOMES.filter((o) => o !== 'resolved').concat('not_evaluated')) {
    assert.match(notice, new RegExp(`${outcome}: '[^']{40,}'`), `${outcome} must carry a distinct notice`);
  }
  assert.match(notice, /unresolved_no_geofence: '[^']*Geofence workbench/);
  assert.match(notice, /unresolved_unverified: '[^']*verified in the Geofence workbench/);
  assert.match(notice, /unresolved_invalid: '[^']*redrawn or re-imported/);
  // Persisted on the observation's geofence_context.
  const context = scan.slice(scan.indexOf('const geofenceContext = {'), scan.indexOf('};', scan.indexOf('const geofenceContext = {')));
  for (const key of ['resolution_status: resolutionStatus', 'governor_overlap_flag: governorOverlapFlag', 'geofence_notice: geofenceNotice']) assert.ok(context.includes(key), `geofence_context must carry ${key}`);
  // Returned in both the parking and the freedom camping envelopes.
  assert.equal((scan.match(/resolution_status: resolutionStatus,\s+governor_overlap_flag: governorOverlapFlag,\s+geofence_notice: geofenceNotice,/g) || []).length, 3);
});

test('rules are applied only on a verified match; unresolved outcomes stay compliance-unknown', () => {
  assert.match(scan, /if \(zoneId\) \{\s+const \{ data: complianceData, error: complianceErr \} = await supabase\.rpc\('calculate_vehicle_compliance'/);
  assert.match(scan, /if \(!zoneId \|\| compliance\.reason === 'no_zone_configured' \|\| compliance\.reason === 'no_rules_configured'\) \{\s+complianceStatus = 'unknown';/);
  // A manually selected zone must be verified (P2) before it can drive a verdict.
  assert.match(scan, /zoneData\.boundary_verification !== 'verified'\) return json\(\{ error: 'An active verified Zone in this organization is required' \}, 409\)/);
});

test('web and mobile clients render the outcome distinctly and never fabricate one', () => {
  for (const outcome of OUTCOMES.concat('not_evaluated')) assert.ok(scanShell.includes(`${outcome}:`), `ScanShell must label ${outcome}`);
  assert.doesNotMatch(scanShell, /No configured zone/);
  assert.match(scanShell, /result\.geofence_notice &&/);
  assert.match(mobileScan, /resolution_status\?: string \| null;/);
  assert.match(mobileScan, /geofence_notice\?: string \| null;/);
  assert.match(mobileScreen, /result\.geofence_notice \?/);
  assert.doesNotMatch(mobileScreen, /No verified zone matched/);
  assert.doesNotMatch(relationships, /\?\? 'outside_all_geofences'/, 'an absent resolver row must not become a valid operational result');
  assert.match(relationships, /resolutionStatus: row\?\.resolution_status \?\? 'unavailable'/);
});
