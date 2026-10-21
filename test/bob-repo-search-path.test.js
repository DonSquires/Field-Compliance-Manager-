const assert = require('node:assert/strict');
const test = require('node:test');
const { pathLikeTerm } = require('../supabase/functions/bob-repo-search/search-logic.ts');

test('pathLikeTerm treats a repository file path as an existence question (live 2026-10-21 AtlasPage.tsx false not_found)', () => {
  assert.deepEqual(pathLikeTerm('apps/web/src/pages/AtlasPage.tsx'), { path: 'apps/web/src/pages/AtlasPage.tsx', dir: 'apps/web/src/pages', base: 'AtlasPage.tsx' });
  assert.deepEqual(pathLikeTerm('./deploy/bob-release-lane/bob-release-lane.timer')?.base, 'bob-release-lane.timer');
  for (const term of ['AtlasPage', 'apps/web/', 'useAtlas()', 'apps/../secret.env', 'BuilderLiveActivity gap', 'a//b.ts']) {
    assert.equal(pathLikeTerm(term), null, term);
  }
});
