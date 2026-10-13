const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');

const atlas = readFileSync(resolve(__dirname, '../supabase/functions/bob-query-atlas/index.ts'), 'utf8');
const caddie = readFileSync(resolve(__dirname, '../supabase/functions/onspace-ai-chat/caddie.ts'), 'utf8');
const conductor = readFileSync(resolve(__dirname, '../supabase/functions/onspace-ai-chat/index.ts'), 'utf8');

test('Atlas inspection is available to the existing admin diagnostic role set', () => {
  assert.match(atlas, /import \{ CAN_SQL, OWNER_EMAILS \}/);
  assert.match(atlas, /if \(!isOwner && !CAN_SQL\.has\(role\)\)/);
  assert.doesNotMatch(atlas, /Forbidden: admiral only/);
});

test('Bob permits Atlas inspection for captain and commander tiers', () => {
  assert.match(caddie, /if \(tool === 'query_atlas'\)/);
  assert.match(caddie, /tool === 'query_atlas'\)[\s\S]{0,300}caps\.tier === 'captain'/);
  assert.match(caddie, /tool === 'query_atlas'\)[\s\S]{0,300}caps\.tier === 'commander'/);
  assert.match(conductor, /t\.tool === 'query_atlas' && \(caps\.tier === 'admiral' \|\| caps\.tier === 'captain' \|\| caps\.tier === 'commander'\)/);
  assert.match(conductor, /tier === 'admiral' \|\| tier === 'captain' \|\| tier === 'commander'\) allowedTools\.push\('query_atlas'\)/);
  assert.match(conductor, /caps\.tier !== 'admiral' && caps\.tier !== 'captain' && caps\.tier !== 'commander'/);
  assert.match(conductor, /const atlasDiagnosticTier = caps\.tier === 'admiral' \|\| caps\.tier === 'captain' \|\| caps\.tier === 'commander'/);
  assert.match(conductor, /explicitReadOnlyAtlasRequest/);
  assert.match(conductor, /chosenTool !== 'query_atlas'/);
  assert.match(conductor, /LOOP_CONTINUABLE_READ_TOOLS\.has\(chosenTool\) && !explicitReadOnlyAtlasRequest/);
});
