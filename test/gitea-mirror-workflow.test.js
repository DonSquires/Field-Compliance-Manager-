const assert = require('node:assert/strict');
const { existsSync, readdirSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');

const workflowsDirectory = resolve(__dirname, '../.github/workflows');

test('GitHub permits only the owner-approved PR verification workflow, not mirror or release workflows', () => {
  const workflowFiles = existsSync(workflowsDirectory)
    ? readdirSync(workflowsDirectory).filter((file) => /\.ya?ml$/i.test(file))
    : [];
  assert.deepEqual(workflowFiles, ['verify-pr.yml']);
});
