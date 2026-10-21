'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { vibeSystemPrompt } = require('../builder-vibe-session');

test('Vibe continuation and navigation lessons ship as platform cards and runtime instructions', () => {
  const sql = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261022223000_bob_vibe_continuation_navigation_cards.sql'), 'utf8');
  assert.match(sql, /SELECT NULL, 'workflow'/);
  assert.match(sql, /builder_vibe_continue_from_evidence/);
  assert.match(sql, /builder_vibe_profile_navigation_diagnosis/);
  assert.match(sql, /WHERE NOT EXISTS/);
  assert.match(sql, /c.organization_id IS NULL AND c.key = v.key/);
  assert.match(sql, /latest 30 owner\/Bob messages and up to 60/);
  assert.match(sql, /nonzero test exit is a failure/);
  assert.match(sql, /flow_reach is distinct from structural fk_reach/);
  const prompt = vibeSystemPrompt();
  assert.match(prompt, /review CONVERSATION SO FAR/);
  assert.match(prompt, /before\/during\/after/);
  assert.match(prompt, /pages\/StaffProfilePage/);
  assert.match(prompt, /\/vibe\/<session-id>\//);
});

test('grounded discovery card preserves the private recovery boundary and verification distinction', () => {
  const sql = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261023001000_bob_vibe_grounded_discovery_card.sql'), 'utf8');
  assert.match(sql, /builder_vibe_grounded_discovery/);
  assert.match(sql, /WHERE NOT EXISTS/);
  assert.match(sql, /c.organization_id IS NULL/);
  assert.match(sql, /Failed writes and failed commands must not reset/);
  assert.match(sql, /does not expand to hosted providers/);
  assert.match(sql, /none proves deployment or live tenant acceptance/);
  assert.match(vibeSystemPrompt(), /VERIFIED STARTING FILES/);
});
