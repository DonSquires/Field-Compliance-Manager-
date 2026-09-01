const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('Atlas conductor accepts entity aliases and requires a synthesized answer', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../supabase/functions/onspace-ai-chat/index.ts'), 'utf8');

  assert.match(source, /toolArgs\.from_type \?\? toolArgs\.entity_type/);
  assert.match(source, /toolArgs\.from_name \?\? toolArgs\.entity_name/);
  assert.match(source, /Do NOT list raw edges, internal IDs, or every returned row/);
  assert.match(source, /results\.slice\(0, 20\)/);
  assert.match(source, /const directFlow = flow\.filter/);
  assert.match(source, /Direct proven flow dependencies/);
  assert.match(source, /const isRenderableNode/);
  assert.match(source, /!\['if', 'then', 'else'\]\.includes/);
  assert.doesNotMatch(source, /FLOW_REACH \(\$\{flow\.length\}\): \$\{JSON\.stringify\(flow\)/);
});