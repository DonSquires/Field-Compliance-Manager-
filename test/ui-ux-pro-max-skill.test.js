const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const skillDir = path.join(root, '.claude/skills/ui-ux-pro-max');
const migration = path.join(root, 'supabase/migrations/20261112110000_builder_ui_ux_pro_max_card.sql');

test('UI UX Pro Max is vendored as a project skill with its licence and FCM precedence', () => {
  const skill = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
  assert.match(skill, /^---\r?\nname: ui-ux-pro-max\r?\n/);
  assert.match(fs.readFileSync(path.join(skillDir, 'LICENSE'), 'utf8'), /^MIT License/);
  assert.match(skill, /Field Compliance Manager precedence/);
  assert.match(skill, /docs\/BOB_ENTERPRISE_SAAS_UX_TRAINING\.md/);
  assert.ok(fs.existsSync(path.join(skillDir, 'scripts/search.py')), 'the local search tool ships with the skill');
  assert.ok(fs.existsSync(path.join(skillDir, 'data/ux-guidelines.csv')), 'the UX guideline catalogue ships with the skill');
});

test('Bob Builder and Vibe receive UI UX Pro Max as an attributed, idempotent platform card', () => {
  const sql = fs.readFileSync(migration, 'utf8');
  assert.match(sql, /INSERT INTO public\.bob_knowledge_cards/);
  assert.match(sql, /existing\.organization_id IS NULL AND existing\.key = card\.key AND existing\.is_active/);
  const cards = [...sql.matchAll(/\('discipline', '([a-z_]+)',[\s\S]*?\$\$([\s\S]*?)\$\$,\s*ARRAY\[([^\]]*)\]\)/g)]
    .map(([, key, content, tags]) => ({ key, content, tags: tags.split(',').map(tag => tag.trim().replace(/'/g, '')) }));
  assert.deepEqual(cards.map(card => card.key), ['ui_ux_pro_max_review']);
  const [card] = cards;
  assert.ok(card.content.length <= 2500, 'the card fits the per-card retrieval cap');
  assert.match(card.content, /\(nextlevelbuilder\/ui-ux-pro-max-skill, MIT\)/);
  assert.match(card.content, /BOB_ENTERPRISE_SAAS_UX_TRAINING/);
  assert.ok(card.tags.includes('builder') && card.tags.includes('vibe'), 'Bob Builder and Vibe can retrieve it');
  assert.ok(!card.tags.includes('independent_code_review'), 'it must not force UI review into every code review');
});
