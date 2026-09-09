const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const fieldOps = fs.readFileSync(path.join(root, 'apps/web/src/pages/FieldOperationsPage.tsx'), 'utf8');
const adminShell = fs.readFileSync(path.join(root, 'apps/web/src/shells/AdminShell.tsx'), 'utf8');
const page = fs.readFileSync(path.join(root, 'apps/web/src/pages/ObservationSearchPage.tsx'), 'utf8');

test('observation search is reachable from the canonical Field Operations route', () => {
  assert.match(fieldOps, /area: 'observation-search'/);
  assert.match(adminShell, /'observation-search'/);
  assert.match(adminShell, /case 'observation-search':\s*return <ObservationSearchPage \/>/s);
  assert.match(page, /search_observations/);
  assert.match(page, /Observation search/);
});
