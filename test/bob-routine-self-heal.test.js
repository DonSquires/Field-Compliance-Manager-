const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const triage = fs.readFileSync('supabase/functions/bob-triage-report/index.ts', 'utf8');
const logic = fs.readFileSync('supabase/functions/bob-triage-report/triage-logic.ts', 'utf8');
const migration = fs.readFileSync('supabase/migrations/20261011180257_automated_routine_self_heal.sql', 'utf8');
const recoveryMigration = fs.readFileSync('supabase/migrations/20261011181836_routine_self_heal_claim_recovery.sql', 'utf8');
const controlPlane = fs.readFileSync('bob-control-plane-server.js', 'utf8');
const autopilot = fs.readFileSync('builder-autopilot.js', 'utf8');
const intake = fs.readFileSync('builder-routine-intake.js', 'utf8');
const monitor = fs.readFileSync('apps/web/src/lib/bobFrictionMonitor.ts', 'utf8');
const app = fs.readFileSync('apps/web/src/App.tsx', 'utf8');

test('signed-in runtime failures produce bounded idempotent friction packets', () => {
  assert.match(app, /<RuntimeFrictionMonitor \/>/);
  assert.match(monitor, /addEventListener\('error'/);
  assert.match(monitor, /addEventListener\('unhandledrejection'/);
  assert.match(monitor, /schema_version: '1'/);
  assert.match(monitor, /client_packet_key: clientPacketKey/);
  assert.match(monitor, /window\.location\.pathname\.slice/);
  assert.doesNotMatch(monitor, /window\.location\.search/);
  assert.doesNotMatch(monitor, /stack:/);
});

test('only deterministic routine bugs enter the automatic repair queue', () => {
  assert.match(logic, /export function classifyRepairRisk/);
  assert.match(logic, /triage !== 'bug'/);
  assert.match(logic, /route !== 'dispatch_flow'/);
  assert.match(logic, /protectedTerms/);
  assert.match(logic, /significantTerms/);
  assert.match(triage, /repairRisk === 'routine'[\s\S]*\? 'queued'/);
  assert.match(migration, /repair_risk = 'routine'/);
  assert.match(migration, /route = 'dispatch_flow'/);
  assert.match(migration, /stop_line_hit IS NULL/);
  assert.match(migration, /'published'/);
  assert.match(recoveryMigration, /automation_status = 'claimed'/);
  assert.match(recoveryMigration, /interval '10 minutes'/);
  assert.match(recoveryMigration, /FOR UPDATE SKIP LOCKED/);
});

test('the control plane claims routine packets and starts governed Builder jobs', () => {
  assert.match(controlPlane, /builder_claim_routine_repairs/);
  assert.match(controlPlane, /builder_create_job_v2/);
  assert.match(controlPlane, /builder_bind_routine_repair/);
  assert.match(controlPlane, /routineRepairBrief\(packet, \{ alsoReported: followers \}\)/);
  assert.match(controlPlane, /planRoutineIntake\(packets, openRepairs\)/);
  assert.match(intake, /Required verification: targeted tests, independent review/);
  assert.match(intake, /Do not redesign, add a feature\/module\/workflow/);
  assert.match(intake, /any migration holds at the release gate for Grandmaster approval/);
});

test('expanded or protected routine work stops for Grandmaster review', () => {
  assert.match(autopilot, /function routineRepairHold/);
  assert.match(autopilot, /repair scope expanded beyond a basic fix/);
  assert.match(autopilot, /routine repair changed more than eight files/);
  assert.match(autopilot, /routine repair changed the database schema/);
  assert.match(autopilot, /routineRepairHold\(\{ job, approval, evidence \}\) \|\| unverifiedReleaseHold\(\{ approval, evidence \}\) \|\| evidentialHold/);
  assert.match(autopilot, /gap = needsEvidence \? evidenceGap\(\{ job, approval, evidence \}\) : null;\n\s+if \(gap\) break;/);
  assert.match(migration, /builder_autopilot_decide_approval_guarded/);
  assert.match(migration, /Routine repair authorization is no longer valid/);
});
