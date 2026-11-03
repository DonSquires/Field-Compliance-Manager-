const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const migration = read('supabase/migrations/20261104130000_report_cctv_card_reviews.sql');
const previous = read('supabase/migrations/20261102210000_rm_monthly_activity_report.sql');

const builderBody = (sql) => {
  const start = sql.indexOf('create or replace function public.build_agreement_activity_report(');
  assert.ok(start >= 0);
  const open = sql.indexOf('$function$', start) + '$function$'.length;
  return sql.slice(open, sql.indexOf('$function$', open));
};
const NZTA = "!~* '(^|[^a-z0-9])nzta([^a-z0-9]|$)'";

test('camera card reviews are categorised as CCTV activity without changing the stored event type', () => {
  const body = builderBody(migration);
  assert.match(body, /= 'cardreview'\s+and a\.note ~\* '\^\\s\*camera activation'\s+then 'camera_activation'/);
  assert.match(body, /else public\.report_activity_category\(a\.kind, a\.event_type,/);
  assert.match(body, /count\(\*\) filter \(where category = 'camera_activation'\) as camera_activations/);
  assert.match(body, /event_type = 'patrol_visit' and category <> 'camera_activation'\) as patrol_visits/);
  assert.doesNotMatch(migration, /update public\.location_events|event_type\s*=\s*'camera_activation'\s*,/i);
});

test('every photo source excludes NZTA owner/vehicle screenshots', () => {
  const body = builderBody(migration);
  const photoRefs = body.slice(body.indexOf('photo_refs as materialized'), body.indexOf('photo_ranked as'));
  const evidenceReads = photoRefs.match(/from public\.evidence_items i|join public\.evidence_items i/g) ?? [];
  const evidenceGuards = photoRefs.split(`coalesce(i.metadata ->> 'original_name', '') ${NZTA}`).length - 1;
  assert.equal(evidenceReads.length, 4);
  assert.equal(evidenceGuards, evidenceReads.length);
  assert.ok(photoRefs.includes(`s.storage_path ${NZTA}`));
});

test('0000 desk entries and administration are reported, while travel stays withheld', () => {
  const body = builderBody(migration);
  assert.match(body, /es\.payload ->> 'source' = 'rm_patrol_log_import'\s+and \(a\.at at time zone 'Pacific\/Auckland'\)::time = time '00:00'/);
  assert.match(body, /\)\s+then 'administration'/);
  assert.match(body, /when c\.category = 'administration' then null\s+when a\.activity in \('travel', 'administration', 'materials'\)/);
  assert.match(body, /\('administration', 'Administration and review', 10\)/);
  // Travel is resolved before the 0000 rule, so a midnight travel row is still withheld.
  assert.ok(body.indexOf("a.activity in ('travel', 'materials')") < body.indexOf("time '00:00'"));
  assert.ok(body.indexOf("then 'camera_activation'") < body.indexOf("time '00:00'"));
});

test('only the CCTV/admin categories, counters and NZTA guards differ from the previous builder', () => {
  const strip = (text) => text
    .replace(/\n\t*-- Camera card reviews[^\n]*\n\t*-- patrol visits;[^\n]*\n/, '\n')
    .replace(/\n\t*left join event_scope es on a\.kind = 'event' and es\.id = a\.record_id/, '')
    .replace(/select case\s+when a\.kind = 'event'[\s\S]*?else (public\.report_activity_category\([^)]*\))\s+end as category/, 'select $1 as category')
    .replace(/\t*-- Travel, (?:materials|administration) and shift[\s\S]*?case\s+(?:when c\.category = 'administration' then null\s+)?when a\.activity/, 'case when a.activity')
    .replace(/\('other_work', 'Other site work', 9\),[\s\S]*?\('travel_admin', '[^']+', 1[23]\)/, 'CATALOG_TAIL')
    .replace(/ and category <> 'camera_activation'\) as patrol_visits/, ') as patrol_visits')
    .replace("filter (where category = 'camera_activation') as camera_activations", "filter (where kind = 'event' and event_type = 'camera_activation') as camera_activations")
    .split(`\n\t\t\tand coalesce(i.metadata ->> 'original_name', '') ${NZTA}`).join('')
    .split(`\n\t\t\tand s.storage_path ${NZTA}`).join('')
    .replace(/\s+/g, ' ').trim();
  assert.equal(strip(builderBody(migration)), strip(builderBody(previous)));
  assert.match(migration, /revoke all on function public\.build_agreement_activity_report\(uuid, timestamptz, timestamptz, integer\) from public, anon, authenticated, service_role;/);
});
