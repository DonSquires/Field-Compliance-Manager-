const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const readSource = (relativePath) => fs.readFileSync(path.resolve(__dirname, relativePath), 'utf8').replace(/\r\n/g, '\n');
const migration = readSource('../supabase/migrations/20260919110000_preview_work_unit_coverage.sql');
const generate = readSource('../supabase/schemas/public/functions/generate_shift_stops.sql');
const rosterPage = readSource('../apps/web/src/pages/RosterOperationsPage.tsx');
const targetsPage = readSource('../apps/web/src/pages/RosterTargetsPage.tsx');
const themes = readSource('../apps/web/src/styles/themes.css');

test('the roster-time coverage preview uses the same day and month rule as generate_shift_stops', () => {
  assert.match(generate, /v_day_of_week = ANY\(cspc\.active_days\)/i);
  assert.match(migration, /\(array_length\(c\.active_days, 1\) is null or v_dow = any\(c\.active_days\)\)/);
  assert.match(migration, /\(array_length\(c\.active_months, 1\) is null or array_length\(c\.active_months, 1\) = 0 or v_month = any\(c\.active_months\)\)/);
  assert.match(migration, /where c\.patrol_route_id = v_unit\.patrol_route_id and c\.active;/);
  assert.match(migration, /'contracted_days', to_jsonb\(v_days\)/);
  // static: the same boundary rule manage_officer_static_post enforces at arrive/depart
  assert.match(migration, /s\.boundary_verification = 'verified' and st_isvalid\(s\.boundary\) and not st_isempty\(s\.boundary\)/);
  assert.match(migration, /raise exception 'Not authorised to roster this work unit'/);
  assert.match(migration, /\nstable\n/);
  assert.doesNotMatch(migration, /create temp table/i);
});

test('the Create shift dialog tells the rosterer, in plain words, and never blocks', () => {
  // the shift's hours travel with the request (20260920130000) so the contracted window can be checked
  assert.match(rosterPage, /supabase\.rpc\('preview_work_unit_coverage', \{ p_work_unit_id: form\.workUnitId, p_shift_date: shiftDate, p_scheduled_start: startDate\.toISOString\(\), p_scheduled_end: endDate && endDate > startDate \? endDate\.toISOString\(\) : null \}\)/);
  assert.match(rosterPage, /No contracted stops on a \$\{weekdayName\(startLocal\)\} for this run — the contract covers \$\{contractedDaysWords\(preview\.contracted_days\)\}\. The shift would have nothing to visit unless stops are added\./);
  assert.match(rosterPage, /has no verified boundary\$\{preview\.place_kind === 'zone' \? ' \(it is a zone, not a site\)' : ''\}, so the officer cannot record arriving or leaving the post\./);
  assert.match(rosterPage, /className=\{`roster-coverage-note is-\$\{words\.tone\}`\} role=\{words\.tone === 'warn' \? 'alert' : 'status'\}/);
  // the submit button's disabled condition does not depend on the preview; a new shift may be an
  // open (unassigned) slot, so only editing an existing draft slot requires an officer
  assert.match(rosterPage, /disabled=\{saving \|\| Boolean\(editingSlot && !form\.officerId\) \|\| !form\.workUnitId \|\| !form\.start \|\| !form\.end\}>\{saving \? 'Creating' : 'Create shift'\}/);
  assert.doesNotMatch(rosterPage, /disabled=\{[^}]*preview[^}]*\}>\{saving \? 'Creating' : 'Create shift'\}/);
  assert.match(rosterPage, /p_staff_id: person\?\.staffId \?\? null/);
});

test('the Work Units card says when a static post\'s place cannot take attendance, before anyone rosters it', () => {
  assert.match(targetsPage, /supabase\.from\('client_sites'\)\.select\('id,name,boundary_verification'\)\.eq\('active', true\)/);
  assert.match(targetsPage, /if \(!location\.site_id\) return `\$\{names\.get\(location\.zone_id \?\? ''\) \?\? 'This place'\} is a zone, not a site, so the officer cannot record arriving at or leaving this post\.`;/);
  assert.match(targetsPage, /if \(site && site\.boundary_verification !== 'verified'\) return `\$\{site\.name\} has no verified boundary yet, so the officer cannot record arriving at or leaving this post\. Verify the site boundary first\.`;/);
  assert.match(targetsPage, /<small className="targets-unit-warning" role="note">/);
});

test('every presentation theme defines the tertiary background used by table headers', () => {
  const tokens = readSource('../apps/web/src/styles/tokens.css');
  const canonical = tokens.match(/:root\s*\{([^}]+)\}/)?.[1];
  assert.ok(canonical, 'canonical root tokens must exist');
  assert.match(canonical, /--color-bg-tertiary: #[0-9a-f]{6};/);
  const blocks = themes.split(/\n(?=\[data-theme=|:root)/).filter((block) => /--color-bg-primary:/.test(block));
  for (const theme of ['light', 'high-contrast', 'night-patrol']) {
    assert.ok(blocks.some((block) => block.startsWith(`[data-theme='${theme}']`)), `missing ${theme} override`);
  }
  for (const block of blocks) assert.match(block, /--color-bg-tertiary: #[0-9a-f]{6};/, block.slice(0, 40));
});
