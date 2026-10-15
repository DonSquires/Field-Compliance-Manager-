const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');
const migration = read('supabase/migrations/20261014235939_govern_bob_job_history.sql');
const runner = read('supabase/functions/bob-job-runner/index.ts');
const approvalsPage = read('apps/web/src/pages/ApprovalsActivityPage.tsx');

test('Bob job history is tenant-scoped and read-only in the browser', () => {
  assert.match(migration, /DROP POLICY IF EXISTS bob_job_rollback_refs_select/);
  assert.match(migration, /run\.job_id = bob_job_rollback_refs\.job_id/);
  assert.match(migration, /public\.org_access_allowed\(run\.organization_id\)/);
  assert.match(migration, /REVOKE ALL ON TABLE public\.bob_job_runs FROM anon, authenticated/);
  assert.match(migration, /REVOKE ALL ON TABLE public\.bob_job_rollback_refs FROM anon, authenticated/);
  assert.match(migration, /GRANT SELECT ON TABLE public\.bob_job_runs TO authenticated/);
  assert.match(migration, /GRANT SELECT ON TABLE public\.bob_job_rollback_refs TO authenticated/);
  assert.doesNotMatch(migration, /USING\s*\(\s*true\s*\)/i);
});

test('job target references do not claim a generic inverse', () => {
  assert.match(migration, /ALTER COLUMN reversible SET DEFAULT false/);
  assert.match(migration, /SET reversible = false/);
  assert.match(runner, /reversible: false/);
  assert.equal(fs.existsSync(path.join(root, 'supabase/functions/bob-reverse-job-step/index.ts')), false);
});

test('administrators can review run progress and safe recovery guidance', () => {
  assert.match(approvalsPage, /from\('bob_job_runs'\)/);
  assert.match(approvalsPage, /from\('bob_job_rollback_refs'\)/);
  assert.match(approvalsPage, /Job history/);
  assert.match(approvalsPage, /Generic reversal and hard deletion are unavailable/);
  assert.match(approvalsPage, /Automatic reversal unavailable/);
  assert.doesNotMatch(approvalsPage, /functions\.invoke\('bob-reverse-job-step'/);
});
