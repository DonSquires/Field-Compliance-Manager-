const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');

const deployment = readFileSync(resolve(__dirname, '../deploy/bob-control-plane/deploy.sh'), 'utf8');

test('Bob control-plane deployment fast-forwards its Gitea checkout and preserves VPS secrets', () => {
  assert.match(deployment, /FCM_GIT_REMOTE:-origin/);
  assert.match(deployment, /FCM_GIT_REF:-main/);
  assert.match(deployment, /git -c safe\.directory="\$app_dir" -C "\$app_dir" fetch --prune "\$git_remote" "\$git_ref"/);
  assert.match(deployment, /git -c safe\.directory="\$app_dir" -C "\$app_dir" merge --ff-only FETCH_HEAD/);
  assert.match(deployment, /\/var\/lib\/bob\/control-plane\.env/);
  assert.match(deployment, /docker compose -f "\$compose_file" up -d --force-recreate bob-control-plane/);
  assert.match(deployment, /for attempt in \{1\.\.30\}/);
  assert.match(deployment, /docker compose -f "\$compose_file" logs --tail 100 bob-control-plane/);
  assert.match(deployment, /172\.16\.0\.1:8091\/health/);
  assert.doesNotMatch(deployment, /gh |github\.com|VPS_SSH_PRIVATE_KEY/);
});