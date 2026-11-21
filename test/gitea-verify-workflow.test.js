'use strict';

// The Gitea Actions verification workflow must run exactly what GitHub's PR verification runs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.join(__dirname, '..');
const load = () => import(pathToFileURL(path.join(root, 'scripts', 'local-ci.mjs')).href);
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('Gitea verification runs the same jobs and steps as GitHub PR verification', async () => {
  const { workflowJobs, parseYaml } = await load();
  const github = workflowJobs(read('.github/workflows/verify-pr.yml'));
  const giteaText = read('.gitea/workflows/verify.yml');
  const gitea = workflowJobs(giteaText);
  const shape = (jobs, { allowGiteaArtifactV3 = false } = {}) => jobs.map((j) => ({
    id: j.id, name: j.name, env: j.env, workingDirectory: j.workingDirectory,
    steps: j.steps.map((s) => ({
      name: s.name,
      run: s.run,
      // Gitea act_runner requires upload-artifact@v3 while GitHub requires @v4.
      uses: allowGiteaArtifactV3 && s.uses === 'actions/upload-artifact@v3'
        ? 'actions/upload-artifact@v4'
        : s.uses,
      always: s.always,
    })),
  }));
  assert.deepEqual(shape(gitea, { allowGiteaArtifactV3: true }), shape(github));
  // Branch pushes run their own copy of this workflow, so it must never read secrets.
  assert.doesNotMatch(giteaText, /secrets\./);
  const on = parseYaml(giteaText).on;
  assert.equal(on.push.branches, '[main]');
  assert.ok('pull_request' in on);
});