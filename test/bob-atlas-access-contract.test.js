const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');

const atlas = readFileSync(resolve(__dirname, '../supabase/functions/bob-query-atlas/index.ts'), 'utf8');
const caddie = readFileSync(resolve(__dirname, '../supabase/functions/onspace-ai-chat/caddie.ts'), 'utf8');
const conductor = readFileSync(resolve(__dirname, '../supabase/functions/onspace-ai-chat/index.ts'), 'utf8');

test('Atlas inspection is available to every active signed-in account (owner ruling 2026-11-01)', () => {
  assert.match(atlas, /import \{ OWNER_EMAILS \} from '\.\.\/_shared\/auth\.ts'/);
  assert.doesNotMatch(atlas, /CAN_SQL/);
  assert.doesNotMatch(atlas, /admin diagnostic role/);
  assert.match(atlas, /const \{ data: \{ user \}, error: authErr \} = await caller\.auth\.getUser\(\)/);
  assert.match(atlas, /if \(authErr \|\| !user\) return json\(\{\s*error: 'Unauthorized'/);
  assert.match(atlas, /select\('deactivated_at'\)\.eq\('id', user\.id\)\.maybeSingle\(\)/);
  assert.match(atlas, /if \(!isOwner && \(!profile \|\| profile\.deactivated_at\)\) return json\(/);
});

test('Bob offers Atlas at every rank, including admin and admin officer', () => {
  assert.match(conductor, /r === 'admin' \|\| r === 'admin_officer' \? 'commander'/);
  assert.match(caddie, /if \(tool === 'query_atlas'\) \{\s*\/\/[^\n]*\n\s*return true;\s*\}/);
  assert.match(conductor, /\n  allowedTools\.push\('query_atlas'\);/);
  assert.doesNotMatch(conductor, /allowedTools\.push\('query_atlas'\)[^\n]*tier/);
  assert.doesNotMatch(conductor, /\) allowedTools\.push\('query_atlas'\)/);
  assert.match(conductor, /\n    t\.tool === 'query_atlas' \|\|\n/);
  assert.doesNotMatch(conductor, /Querying the Atlas is restricted/);

  // The explicit-request shortcut that forces an Atlas read is rank-neutral too.
  assert.doesNotMatch(conductor, /atlasDiagnosticTier/);
  assert.match(conductor, /const explicitAtlasRequest = \/\\b\(\?:atlas\|terrain/);
  assert.match(conductor, /explicitReadOnlyAtlasRequest/);
  assert.match(conductor, /chosenTool !== 'query_atlas'/);
  assert.match(conductor, /LOOP_CONTINUABLE_READ_TOOLS\.has\(chosenTool\) && !explicitReadOnlyAtlasRequest/);
});
