const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');

const source = readFileSync(resolve(__dirname, '../apps/mobile/src/lib/officerPtt.ts'), 'utf8');
const migration = readFileSync(
  resolve(__dirname, '../supabase/migrations/20260903150000_govern_ptt_transmissions.sql'),
  'utf8'
);

test('mobile PTT uses governed open_ptt_transmission and close_ptt_transmission RPCs', () => {
  assert.match(source, /rpc\('open_ptt_transmission'/);
  assert.match(source, /rpc\('close_ptt_transmission'/);
  assert.match(source, /PTT transmission start was not confirmed/);
});

test('mobile PTT records transcripts via governed record_radio_transcript_segment RPC', () => {
  assert.match(source, /rpc\('record_radio_transcript_segment'/);
  assert.match(source, /p_sequence: sequence/);
  assert.match(source, /p_confidence: confidence/);
  assert.match(source, /Radio transcript segment was not confirmed/);
});

test('migration defines ptt_transmissions and radio_transcript_segments RLS and RPCs', () => {
  assert.match(migration, /create or replace function public\.open_ptt_transmission/);
  assert.match(migration, /create or replace function public\.close_ptt_transmission/);
  assert.match(migration, /create or replace function public\.record_radio_transcript_segment/);
  assert.match(migration, /ptt_transmission_started/);
  assert.match(migration, /ptt_transmission_ended/);
});
