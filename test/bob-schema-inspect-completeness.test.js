const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');

const conductor = readFileSync(resolve(__dirname, '../supabase/functions/onspace-ai-chat/index.ts'), 'utf8');

test('Bob schema inspection preserves a complete 60-table window and directs further discovery through Atlas pagination', () => {
  assert.doesNotMatch(conductor, /\(r\.data\.tables \?\? \[\]\)\.slice\(0, 40\)/);
  assert.match(conductor, /const shownTables = tableRows\.slice\(0, 60\)/);
  assert.match(conductor, /Use query_atlas capability_map with pagination/);
  assert.match(conductor, /Schema \(read-only, \$\{shownTables\.length\} of \$\{totalTables\} table\(s\)\)/);
});