const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const migration = read('supabase/migrations/20261106090000_report_withhold_routine_cards_and_duplicates.sql');
const previous = read('supabase/migrations/20261105140000_report_withhold_admin_card_review_observations.sql');

const body = (sql) => {
  const start = sql.indexOf('create or replace function public.build_agreement_activity_report_core(');
  assert.ok(start >= 0);
  const open = sql.indexOf('$function$', start) + '$function$'.length;
  return sql.slice(open, sql.indexOf('$function$', open));
};

test('a photo-less card swap is withheld as routine, unless it is an incident', () => {
  const sql = body(migration);
  const rule = sql.slice(sql.indexOf("then 'shift_marker'"), sql.indexOf("then 'routine_card'"));
  assert.match(rule, /coalesce\(pc\.n, 0\) = 0/);
  assert.match(rule, /c\.category <> 'incident'/);
  assert.match(rule, /'cardreview'/);
  assert.match(rule, /\(replaced\|replace\|swapped\|swap\|changed\|change\|new\) \(sd \)\?cards\?/);
});

test('a repeated entry is reported once, matched on minute, place, officer, title, comment and action', () => {
  const sql = body(migration);
  const rule = sql.slice(sql.indexOf("then 'routine_card'"), sql.indexOf("then 'duplicate'"));
  for (const part of [/date_trunc\('minute', a\.at at time zone 'Pacific\/Auckland'\)/, /lower\(coalesce\(a\.place_name, ''\)\)/,
    /patroller_raw/, /es\.observed_entity_id/, /os\.officer_id/, /a\.title/, /a\.note/, /a\.action/]) {
    assert.match(rule, part);
  }
  // The copy carrying the most photos is the one kept.
  assert.match(rule, /order by coalesce\(pc\.n, 0\) desc, a\.at, a\.record_id::text\s*\) > 1/);
  assert.match(sql, /left join observation_scope os on a\.kind = 'observation' and os\.id = a\.record_id/);
});

test('withheld routine cards and duplicates are accounted for and reconciled', () => {
  const sql = body(migration);
  assert.match(sql, /'operationalWithheld', sc\.withheld_travel_admin \+ sc\.withheld_shift_markers \+ sc\.withheld_routine_cards \+ sc\.withheld_duplicates/);
  assert.match(sql, /'withheldRoutineCards', sc\.withheld_routine_cards/);
  assert.match(sql, /'withheldDuplicates', sc\.withheld_duplicates/);
  assert.match(sql, /sc\.all_entries = t\.entries \+ sc\.withheld_travel_admin \+ sc\.withheld_shift_markers \+ sc\.withheld_routine_cards \+ sc\.withheld_duplicates/);
});

test('the builder otherwise keeps the previous definition and its server-only grants', () => {
  const tail = (sql) => sql.slice(sql.lastIndexOf('$function$'));
  assert.equal(tail(migration).replace(/comment on function[\s\S]*?';/i, ''), tail(previous).replace(/comment on function[\s\S]*?';/i, ''));
  assert.match(tail(migration), /revoke all on function "public"\."build_agreement_activity_report_core"\([^)]*\) from public, "anon", "authenticated", "service_role"/i);
  assert.equal(body(migration).split('\n').length - body(previous).split('\n').length, 25);
});
