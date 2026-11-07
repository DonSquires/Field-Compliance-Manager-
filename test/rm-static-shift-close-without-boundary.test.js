const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const migration = fs.readFileSync(
  path.join(root, 'supabase', 'migrations', '20261108121000_static_post_departure_without_boundary.sql'),
  'utf8',
);

const functionBody = (sql, header) => {
  const start = sql.indexOf(header);
  assert.notEqual(start, -1, `missing function: ${header}`);
  const open = sql.indexOf('$function$', start) + '$function$'.length;
  const close = sql.indexOf('$function$', open);
  return sql.slice(open, close);
};

const squash = (text) => text.replace(/\s+/g, ' ').trim();

const presence = squash(functionBody(migration, 'create or replace function public.record_static_shift_presence('));
const readiness = squash(functionBody(migration, 'create or replace function public.get_officer_attendance_readiness('));

test('a static post can be departed before it ever reached on_scene', () => {
  assert.match(
    presence,
    /if v_stop\.status not in \('pending','en_route','on_scene'\) then raise exception 'Static post cannot be completed from this state'/,
  );
  assert.doesNotMatch(presence, /Start this static post before ending the shift/);
});

test('an unverified position still needs an operations reason on depart', () => {
  assert.match(presence, /Explain the unverified attendance for operations review/);
  assert.match(presence, /'review_required',v_position->>'status' <> 'on_site'/);
});

test('the single static post stop no longer blocks the end-of-shift gate', () => {
  assert.match(readiness, /if v_single then .*v_stops := 0;/);
  assert.doesNotMatch(readiness, /status not in \('on_scene','completed','skipped','cancelled'\)/);
});

test('other required work still blocks ending the shift', () => {
  assert.match(readiness, /sm\.module_key <> 'static_guarding'/);
  assert.match(readiness, /'can_end',v_clear and \(v_source->>'debrief_submitted'\)::boolean/);
  assert.match(readiness, /active_welfare_alert_count/);
});
