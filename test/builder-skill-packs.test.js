'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const generator = () => import('../scripts/generate-builder-skill-cards.mjs');
const pack = { source: 'blader/humanizer', revision: 'b48c832f0f809c1b5658edbb838c2521b72f2413', slug: 'humanizer', label: 'Humanizer' };

test('skill cards retain immutable source, full guidance hash, license and non-authoritative scope', async () => {
  const { makeSkillCard } = await generator();
  const card = makeSkillCard({ pack, name: 'humanizer', skillPath: 'SKILL.md', content: 'Original guidance.', license: 'MIT notice fixture' });
  assert.equal(card.key, 'agent_skill_humanizer_humanizer');
  assert.equal(card.source, 'https://github.com/blader/humanizer/blob/b48c832f0f809c1b5658edbb838c2521b72f2413/SKILL.md');
  assert.ok(card.tags.includes('builder') && card.tags.includes('vibe') && card.tags.includes('in_app_bob'));
  assert.match(card.content, /Original guidance\./);
  assert.match(card.content, /MIT notice fixture/);
  assert.match(card.content, /sha256: [a-f0-9]{64}/);
  assert.match(card.content, /Reference guidance only/);
  assert.equal(card.tags.includes('independent_code_review'), false);
});

test('unverified licensing creates a reference instead of redistributing instructions', async () => {
  const { makeSkillCard } = await generator();
  const card = makeSkillCard({ pack, name: 'reference', skillPath: 'skills/reference/SKILL.md', content: 'Do not redistribute me', license: null });
  assert.doesNotMatch(card.content, /Do not redistribute me/);
  assert.match(card.content, /reference-only/);
  assert.throws(() => makeSkillCard({ pack, name: '../escape', skillPath: 'SKILL.md', content: 'x', license: 'MIT' }), /Invalid/);
});

test('pinned source verification accepts only checkout newline conversion, not changed instructions', async () => {
  const { makeSkillCard } = await generator();
  const fixture = { pack, name: 'humanizer', skillPath: 'SKILL.md', content: 'first\nsecond\n', license: 'MIT' };
  assert.ok(makeSkillCard({ ...fixture, installedContent: 'first\r\nsecond\r\n' }).content.includes('first\nsecond\n'));
  assert.throws(() => makeSkillCard({ ...fixture, installedContent: 'first\nchanged\n' }), /differs from pinned/);
});

test('skill seed is safe for SQL-like content and rejects duplicate or empty catalogs', async () => {
  const { makeSkillCard, renderSkillMigration } = await generator();
  const card = makeSkillCard({ pack, name: 'humanizer', skillPath: 'SKILL.md', content: "$$'); DROP TABLE evidence; --", license: 'MIT' });
  assert.match(renderSkillMigration([card]), /jsonb_to_recordset/);
  assert.throws(() => renderSkillMigration([]), /empty/);
  assert.throws(() => renderSkillMigration([card, card]), /Duplicate/);
});

test('actual PostgreSQL applies all skill cards idempotently without touching tenant cards', {
  skip: process.env.BOB_TEST_POSTGRES !== '1',
}, async () => {
  const migration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261112184851_builder_external_skill_packs.sql'), 'utf8');
  const searchMigration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261112190954_builder_platform_knowledge_keyword_search.sql'), 'utf8');
  const name = `fcm-skill-packs-${randomUUID()}`;
  const docker = args => execFileSync('docker', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  let created = false;
  try {
    docker(['run', '-d', '--name', name, '--network', 'none', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgres:17']);
    created = true;
    let ready = false;
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      try { docker(['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']); ready = true; break; }
      catch { await new Promise(resolve => setTimeout(resolve, 500)); }
    }
    assert.ok(ready, `PostgreSQL must finish its socket-only bootstrap and accept TCP connections.\n${ready ? '' : docker(['logs', name])}`);
    const psql = sql => execFileSync('docker', ['exec', '-i', name, 'psql', '-h', '127.0.0.1', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At'], {
      input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024,
    }).trim();
    psql(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE bob_knowledge_cards(id uuid DEFAULT gen_random_uuid(),updated_at timestamptz DEFAULT now(),organization_id uuid,category text,key text,title text,content text,tags text[],source text,is_active boolean);
      CREATE TABLE bob_model_catalog(provider text,model_name text,privacy_class text,cost_tier int,notes text,UNIQUE(provider,model_name));
      GRANT SELECT ON bob_knowledge_cards TO service_role;
      INSERT INTO bob_knowledge_cards(organization_id,category,key,title,content,tags,source,is_active)
      VALUES('00000000-0000-4000-8000-000000000001','fixture','agent_skill_humanizer_humanizer','code review','unchanged',ARRAY[]::text[],'fixture',true);`);
    psql(migration);
    psql("UPDATE bob_model_catalog SET cost_tier=1 WHERE provider='gemini'");
    psql(migration);
    const result = JSON.parse(psql(`SELECT json_build_object(
      'global', (SELECT count(*) FROM bob_knowledge_cards WHERE organization_id IS NULL),
      'growth', (SELECT count(*) FROM bob_knowledge_cards WHERE organization_id IS NULL AND 'corey_growth'=ANY(tags)),
      'tenant', (SELECT content FROM bob_knowledge_cards WHERE organization_id IS NOT NULL),
      'gemini', (SELECT privacy_class FROM bob_model_catalog WHERE provider='gemini'),
      'gemini_cost', (SELECT cost_tier FROM bob_model_catalog WHERE provider='gemini'))`));
    assert.deepEqual(result, { global: 112, growth: 53, tenant: 'unchanged', gemini: 'external', gemini_cost: 1 });
    psql(searchMigration);
    psql(searchMigration);
    assert.equal(psql("SET ROLE service_role; SELECT key FROM bob_search_platform_knowledge(ARRAY['code','review'],1); RESET ROLE").split('\n').filter(line => !['SET', 'RESET'].includes(line)).join(''), 'agent_skill_mattpocock_code_review');
    assert.equal(psql("SELECT count(*) FROM bob_search_platform_knowledge(ARRAY['code','review'],6) r JOIN bob_knowledge_cards c USING(id) WHERE c.organization_id IS NOT NULL"), '0');
    for (const role of ['anon', 'authenticated']) {
      assert.equal(psql(`SELECT has_function_privilege('${role}','public.bob_search_platform_knowledge(text[],integer)','EXECUTE')`), 'f');
    }
    assert.throws(() => psql("SELECT * FROM bob_search_platform_knowledge(ARRAY[]::text[],1)"), /keyword terms/i);
  } finally {
    if (created) docker(['rm', '-f', name]);
  }
});
