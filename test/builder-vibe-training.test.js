'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { vibeSystemPrompt } = require('../builder-vibe-session');
const { ATLAS_RESEARCH_GUIDANCE, systemPrompt, DEFAULT_LIMITS } = require('../builder-agentic-engineer');
const { builderChatSystemPrompt } = require('../builder-chat-session');

test('all builder modes carry the same Atlas research navigation and butterfly-effect guidance', () => {
  for (const prompt of [vibeSystemPrompt(), builderChatSystemPrompt(), systemPrompt({ lane: 'backend', limits: DEFAULT_LIMITS })]) {
    assert.ok(prompt.includes(ATLAS_RESEARCH_GUIDANCE));
  }
  assert.match(ATLAS_RESEARCH_GUIDANCE, /source_file/);
  assert.match(ATLAS_RESEARCH_GUIDANCE, /downstream traverses source to target; upstream traverses target to source/);
  assert.match(ATLAS_RESEARCH_GUIDANCE, /reader is upstream of the table/);
  assert.match(ATLAS_RESEARCH_GUIDANCE, /secured_by/);
  assert.match(ATLAS_RESEARCH_GUIDANCE, /fk_reach separate from flow_reach/);
  assert.match(ATLAS_RESEARCH_GUIDANCE, /wired is not exercised/);
  assert.match(ATLAS_RESEARCH_GUIDANCE, /Guidance-only questions/);
  assert.match(ATLAS_RESEARCH_GUIDANCE, /ATLAS IS A MAP, NOT EVIDENCE/);
  assert.match(ATLAS_RESEARCH_GUIDANCE, /investigate those areas to establish facts/);
  assert.match(ATLAS_RESEARCH_GUIDANCE, /Report map leads, independently verified facts and unknowns separately/);
  assert.match(ATLAS_RESEARCH_GUIDANCE, /leave its behavior unverified/);
  const sql = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261025103500_bob_atlas_research_navigation_card.sql'), 'utf8');
  assert.match(sql, /builder_atlas_research_navigation/);
  assert.match(sql, /WHERE NOT EXISTS/);
  assert.match(sql, /organization_id IS NULL/);
  assert.match(sql, /source_file/);
  assert.match(sql, /Before:.*During:.*After:/s);
  assert.match(sql, /invocation receipt/);
  const card = sql.match(/\$\$([\s\S]*?)\$\$/)[1];
  assert.ok(card.length <= 2500, 'the complete lesson must fit the actual per-card retrieval cap');
});

test('Atlas card corrections replace contradictory proof teaching and invalidate stale embeddings', () => {
  const sql = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261025105500_bob_atlas_map_not_evidence.sql'), 'utf8');
  assert.match(sql, /WHERE c.organization_id IS NULL AND c.key = v.key/);
  for (const column of ['embedding', 'embedding_384', 'embedding_model', 'embedded_at']) {
    assert.ok(sql.includes(`${column} = NULL`));
  }
  assert.match(sql, /updated_at = now\(\)/);
  const cards = [...sql.matchAll(/\('([^']+)',\s*\$\$([\s\S]*?)\$\$/g)];
  assert.deepEqual(cards.map(([, key]) => key), [
    'builder_atlas_research_navigation', 'bob_atlas_blast_radius', 'bob_wired_vs_dormant', 'bob_capability_map_tool',
  ]);
  for (const [, key, content] of cards) {
    assert.ok(content.length <= 2500, `${key} must fit the actual retrieval cap`);
    assert.match(content, /Atlas is a map, not evidence/);
    assert.match(content, /[Rr]esearch/);
    assert.match(content, /verified facts and unknowns/);
    assert.doesNotMatch(content, /PROVEN DATA FLOW|flow_reach is proven/);
  }
});

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

test('Vibe teaches workflow evidence, test-data provenance and the correct browser runner', () => {
  const prompt = vibeSystemPrompt();
  assert.match(prompt, /Playwright specs under e2e\/ belong to browser_test or human_test, not Vitest/);
  assert.match(prompt, /revision: "worktree"\|"base"/);
  assert.match(prompt, /AFTER \(saved record, reload, back\/forward/);
  assert.match(prompt, /numeric-only values start with "999"/);
  assert.match(prompt, /text values start with "Bob Test"/);
  assert.match(prompt, /identified by ID, tenant and run provenance/);
  assert.match(prompt, /"unwired" means no registered caller, not missing database EXECUTE grants/);
  assert.match(prompt, /Visual baselines are only for a screenshot mismatch reported by a visual Playwright assertion/);
  assert.match(prompt, /list the snapshot directory and copy the exact existing PNG path/);
  assert.match(prompt, /do not call the tool again until exact eligible paths are verified/);
  assert.match(prompt, /only after a visual assertion reports a mismatch on an intentionally changed spec/);
  const config = fs.readFileSync(path.join(__dirname, '../apps/web/vite.config.ts'), 'utf8');
  assert.match(config, /exclude: \[\.\.\.configDefaults.exclude, 'e2e\/\*\*'\]/);
  const spec = fs.readFileSync(path.join(__dirname, '../apps/web/e2e/dr-bob-human-test.spec.ts'), 'utf8');
  assert.match(spec, /import \{ expect, test \} from '@playwright\/test'/);
  assert.doesNotMatch(spec, /process\.env\.VITEST|let test: any|Intentionally left empty/);
});

test('Vibe teaches per-message non-sensitive attachment consent without authorizing raw files', () => {
  const prompt = vibeSystemPrompt();
  assert.match(prompt, /owner explicitly opts in on that message/);
  assert.match(prompt, /no personal, confidential, restricted, credential, or proprietary information/);
  assert.match(prompt, /never raw attachment bytes/);
  const sql = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261025130000_builder_vibe_attachment_cloud_opt_in.sql'), 'utf8');
  assert.match(sql, /public\.builder_vibe_require_owner\(\)/);
  assert.match(sql, /created_by = v_user AND status <> 'closed'\s+FOR UPDATE/);
  assert.match(sql, /coalesce\(p_allow_ollama_cloud, false\)/);
  assert.match(sql, /Request id was already used with different attachment consent/);
  assert.match(sql, /AND NOT \(payload \? 'external_attachment_consent'\)/);
  assert.match(sql, /'policy_version', 'non_sensitive_context_v1'/);
  assert.match(sql, /'actor_user_id', v_user/);
  assert.match(sql, /'recorded_at', now\(\)/);
  assert.match(sql, /FROM PUBLIC, anon/);
});

test('Builder engineers use authenticated Playwright fixtures and preserve existing test coverage', () => {
  const prompt = systemPrompt({ lane: 'frontend', limits: DEFAULT_LIMITS });
  assert.match(prompt, /never delete, rename, weaken or replace an existing test/);
  assert.match(prompt, /inspect apps\/web\/e2e\/fixtures\.ts and a passing authenticated spec/);
  assert.match(prompt, /bare unauthenticated page for a protected route/);
});
