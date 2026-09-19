const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20260919090000_shift_start_window.sql'), 'utf8');
const schedulePage = fs.readFileSync(path.resolve(__dirname, '../apps/web/src/pages/OfficerSchedulePage.tsx'), 'utf8');

test('a shift can be started from an hour before its rostered start; earlier is refused in plain words, late is fine, admins are not bound', () => {
  assert.match(migration, /c_start_window constant interval := interval '60 minutes';/);
  assert.match(migration, /if not v_is_admin and v_shift\.scheduled_start - v_at > c_start_window then/);
  assert.match(migration, /raise exception 'Too early to start this shift: it is rostered for later\. You can start it from an hour before its rostered start\.'/);
  assert.match(migration, /hint = format\('opens_at=%s', to_char\(\(v_shift\.scheduled_start - c_start_window\) at time zone 'UTC'/);
  assert.doesNotMatch(migration, /scheduled_end < v_at/);
  assert.match(migration, /'started_early_by_minutes', greatest\(0, floor\(extract\(epoch from \(v_shift\.scheduled_start - v_shift\.actual_start\)\) \/ 60\)\)::integer/);
  // the one-shift-at-a-time receipt and position advisory are kept intact
  assert.match(migration, /v_position := public\.evaluate_shift_start_position\(v_shift\.id, p_gps_lat, p_gps_lng\);/);
  assert.match(migration, /v_prev_id, v_prev_type, v_prev_started;/);
});

test('the schedule mirrors the window: no Start button before it opens, the card says when instead', () => {
  assert.match(schedulePage, /export const SHIFT_START_WINDOW_MINUTES = 60;/);
  assert.match(schedulePage, /export const canStartNow = \(scheduledStart: string, now: number = Date\.now\(\)\): boolean => startOpensAt\(scheduledStart\)\.getTime\(\) <= now;/);
  assert.match(schedulePage, /canStartNow\(shift\.scheduled_start\) \? <button type="button" className="officer-swap-button" onClick=\{\(\) => void startShift\(shift\)\}/);
  assert.match(schedulePage, /<small className="officer-start-opens">\{startOpensWords\(shift\.scheduled_start\)\}<\/small>/);
  assert.match(schedulePage, /return `You can start from \$\{sameDay \? '' : `\$\{formatDate\(opens\.toISOString\(\)\)\}, `\}\$\{formatTime\(opens\.toISOString\(\)\)\}`;/);
});

test('the officer reads their own status words and a correct plural', () => {
  assert.match(schedulePage, /published: 'Waiting for your answer', accepted: 'Accepted', in_progress: 'On shift now'/);
  assert.match(schedulePage, /\{officerShiftStatusLabel\(shift\.status\)\}/);
  assert.match(schedulePage, /planned \{shift\.total_stops === 1 \? 'stop' : 'stops'\}/);
  assert.doesNotMatch(schedulePage, /\{shift\.total_stops\} planned stops/);
});
