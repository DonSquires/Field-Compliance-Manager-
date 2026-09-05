const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');

const workflow = readFileSync(resolve(__dirname, '../.github/workflows/mirror-to-gitea.yml'), 'utf8');

test('Gitea mirror follows GitHub main and refuses divergent history', () => {
  assert.match(workflow, /branches: \[main\]/);
  assert.match(workflow, /GITEA_MIRROR_USERNAME: \$\{\{ secrets\.GITEA_MIRROR_USERNAME \}\}/);
  assert.match(workflow, /GITEA_MIRROR_TOKEN: \$\{\{ secrets\.GITEA_MIRROR_TOKEN \}\}/);
  assert.match(workflow, /git fetch gitea main/);
  assert.match(workflow, /git merge-base --is-ancestor "\$GITEA_MAIN" HEAD/);
  assert.match(workflow, /refusing to overwrite mirror history/);
  assert.match(workflow, /git push gitea HEAD:refs\/heads\/main/);
  assert.doesNotMatch(workflow, /git push .*--force/);
});
