const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { runVisualCheck } = require('../browser-verifier');

test('browser verifier captures app evidence and records structured output', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-verifier-'));
  const artifactDir = path.join(root, 'artifacts');
  const fakePlaywright = {
    chromium: {
      launch: async () => ({
        newPage: async () => ({
          on: () => {},
          goto: async () => {},
          waitForLoadState: async () => {},
          title: async () => 'App Title',
          locator: () => ({ innerText: async () => 'App body text' }),
          screenshot: async ({ path: screenshotPath }) => {
            fs.writeFileSync(screenshotPath, 'fake screenshot');
          }
        }),
        close: async () => {}
      })
    }
  };

  const result = await runVisualCheck({
    appUrl: 'http://127.0.0.1:4173',
    sourceDir: root,
    artifactDir,
    playwright: fakePlaywright,
    timeoutMs: 5000,
    testName: 'browser-check'
  });

  assert.equal(result.result.status, 'passed');
  assert.equal(fs.existsSync(result.manifestPath), true);
  assert.equal(fs.existsSync(result.screenshotPath), true);
  fs.rmSync(root, { recursive: true, force: true });
});
