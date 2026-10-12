const assert = require('node:assert/strict');
const { existsSync, readdirSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');

const workflowsDirectory = resolve(__dirname, '../.github/workflows');

test('GitHub is the source host only; no GitHub Actions workflows run', () => {
  const workflowFiles = existsSync(workflowsDirectory)
    ? readdirSync(workflowsDirectory).filter((file) => /\.ya?ml$/i.test(file))
    : [];
  assert.deepEqual(workflowFiles, []);
});
