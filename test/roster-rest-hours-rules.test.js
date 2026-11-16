const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20260920010000_roster_rest_and_hours_rules.sql'), 'utf8');
const rosterPage = fs.readFileSync(path.resolve(__dirname, '../apps/web/src/pages/RosterOperationsPage.tsx'), 'utf8');
const hrPage = fs.readFileSync(path.resolve(__dirname, '../apps/web/src/pages/RosterHRPage.tsx'), 'utf8');
const rulesPanel = fs.readFileSync(path.resolve(__dirname, '../apps/web/src/components/RosterRulesPanel.tsx'), 'utf8');
const workforceSections = fs.readFileSync(path.resolve(__dirname, '../apps/web/src/lib/workforceSections.ts'), 'utf8');

test('rest and hours are measured the way a rosterer reads them: NZ Monday-Sunday week, nearest other shift, days in a row', () => {
  assert.match(migration, /create or replace function public\.roster_assignment_load\(p_staff_id uuid, p_scheduled_start timestamptz, p_scheduled_end timestamptz, p_exclude_slot_id uuid default null\)/);
  assert.match(migration, /date_trunc\('week', p_scheduled_start at time zone 'Pacific\/Auckland'\)::date/);
  // the new slot itself counts toward the week and the day chain
  assert.match(migration, /extract\(epoch from \(p_scheduled_end - p_scheduled_start\)\) \/ 3600/);
  // plain sentences, no trailing zeros
  assert.match(migration, /Only %s hours'' rest from the nearest other shift; this organisation requires %s', trim_scale\(/);
  assert.match(migration, /%s hours in the week starting %s, over the %s-hour limit', trim_scale\(/);
  assert.match(migration, /Day %s in a row, over the limit of %s/);
  // rules that are recorded but not enforced never block
  assert.match(migration, /if not found or not v_rules\.enforced then return null; end if;/);
});

test('the preview and the trigger use the same check, and only administrators of the employer or a branch the officer is authorised at can preview', () => {
  assert.match(migration, /create or replace function public\.preview_roster_assignment\(p_staff_id uuid, p_scheduled_start timestamptz, p_scheduled_end timestamptz, p_exclude_slot_id uuid default null\)/);
  assert.match(migration, /public\.is_admin_for_org\(v_staff\.organization_id\) or exists \(\s*select 1 from public\.staff_branch_authorisations a/);
  assert.match(migration, /'conflict', public\.staff_fatigue_conflict\(v_staff\.id, p_scheduled_start, p_scheduled_end, p_exclude_slot_id\)/);
  assert.match(migration, /'credential_warnings'/);
  assert.match(migration, /raise exception 'Fatigue rule breach: %', v_fatigue;/);
  // a branch-authorised officer can be rostered by the branch, not only the employer
  assert.match(migration, /sba\.user_id = coalesce\(v_staff\.user_id, v_staff\.id\) and sba\.branch_org_id = v_slot\.organization_id/);
});

test('rules are written only through the governed, audited RPC with sane ranges', () => {
  assert.match(migration, /create or replace function public\.manage_organization_fatigue_rules\(p_organization_id uuid, p_min_rest_hours_between_shifts numeric, p_max_hours_per_week numeric, p_max_consecutive_days integer, p_enforced boolean default true\)/);
  assert.match(migration, /raise exception 'Not authorised to set rostering rules for this organisation'/);
  assert.match(migration, /p_min_rest_hours_between_shifts > 24/);
  assert.match(migration, /p_max_hours_per_week > 168/);
  assert.match(migration, /p_max_consecutive_days > 31/);
  assert.match(migration, /on conflict \(organization_id\) do update/);
  assert.match(migration, /'roster_rules_updated', 'organization_fatigue_rules'/);
  assert.match(migration, /'before', case when v_before\.organization_id is null then null else to_jsonb\(v_before\) end,/);
  assert.match(migration, /'after', to_jsonb\(v_after\)\)\);/);
  assert.match(migration, /grant execute on function public\.manage_organization_fatigue_rules/);
  assert.match(migration, /grant execute on function public\.preview_roster_assignment/);
});

test('the rosterer sees rest, hours and days in a row before the shift exists, and a refusal lands inside the dialog', () => {
  assert.match(rosterPage, /supabase\.rpc\('preview_roster_assignment', \{ p_staff_id: person\.staffId, p_scheduled_start: new Date\(effectiveStart\)\.toISOString\(\), p_scheduled_end: new Date\(form\.end\)\.toISOString\(\) \}\)/);
  assert.match(rosterPage, /The roster will refuse this: \$\{preview\.conflict\}\./);
  assert.match(rosterPage, /rest from the nearest other shift/);
  assert.match(rosterPage, /No rest and hours rules are set for this officer\\'s employer, so the roster is not checking fatigue\. Set them in Rosters › Shift setup & open shifts › Rest & hours rules\./);
  assert.match(rosterPage, /recorded but not enforced — the roster will accept this even if it breaks them/);
  assert.match(rosterPage, /expires \$\{dayWords\(warning\.expiry_date\)\}, before this shift ends\./);
  assert.match(rosterPage, /className="roster-assignment-note is-stop roster-dialog-error" role="alert"/);
  // advisory in the browser; the trigger decides
  assert.doesNotMatch(rosterPage, /disabled=\{[^}]*assignmentPreview/);
});

test('Rosters exposes the rules for the employing organisation in plain words', () => {
  assert.match(hrPage, /\{ id: 'roster-rules', label: 'Rest & hours rules' \}/);
  assert.match(hrPage, /\{ id: 'rostering', label: 'Rostering', tabs: \[\.\.\.ROSTERING_HR_TABS\] \}/);
  assert.match(workforceSections, /ROSTERING_HR_TABS = \['shift-templates', 'roster-rules', 'coverage', 'oncall', 'court'\]/);
  assert.match(hrPage, /<RosterRulesPanel organizationId=\{profile\.employerOrganizationId \?\? profile\.organizationId\}/);
  assert.match(rulesPanel, /supabase\.rpc\('manage_organization_fatigue_rules', \{/);
  assert.match(rulesPanel, /from\('organization_fatigue_rules'\)\.select\(/);
  assert.match(rulesPanel, /Not set\. The roster is not checking rest or hours for anyone yet/);
  assert.match(rulesPanel, /Recorded but not enforced: the roster will accept shifts that break these rules\./);
  assert.match(rulesPanel, /Saved\. From now on the roster refuses a shift that breaks these rules and says which one\./);
  assert.match(rulesPanel, /min="0" max="24"/);
  assert.match(rulesPanel, /min="1" max="168"/);
  assert.match(rulesPanel, /min="1" max="31"/);
});

test('a licence that outlives the shift never blocks rostering; expired or unverified says exactly what to do', () => {
  assert.doesNotMatch(rosterPage, /cannot be assigned until their credential status is clear/);
  // Wording is per credential, not "licence": the branch RPC aggregates every credential type and
  // does not prove a specific licence; the assignment preview names the type.
  assert.match(rosterPage, /credentials have not been confirmed\. Check People › Credentials before assigning\./);
  assert.match(rosterPage, /has unverified credentials on file\. Verify them in People › Credentials first\./);
  assert.match(rosterPage, /has an expired credential\$\{person\.credentialExpiry \? ` \(\$\{dayWords\(person\.credentialExpiry\)\}\)` : ''\}\. Record the renewal in People › Credentials first\./);
  assert.match(rosterPage, /has a credential expiring \$\{dayWords\(person\.credentialExpiry\)\}, before this shift ends\. Record the renewal in People › Credentials first\./);
  assert.match(rosterPage, /const blocker = dimensionsChanged && person \? credentialBlocker\(person, form\.end\) : null/);
  assert.match(rosterPage, /const blocker = person \? credentialBlocker\(person, form\.end\) : null; if \(blocker\)/);
  assert.match(rosterPage, /\{credentialBadgeWords\(person\)\}<\/i>/);
  assert.match(rosterPage, /return `Credential expires \$\{person\.credentialExpiry \? dayWords\(person\.credentialExpiry\) : 'soon'\}`;/);
});
