const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createAssessment } = require('../assessment-manifest');

test('assessment inventories code and services but excludes secrets and runtime data', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bob-assessment-'));
  fs.mkdirSync(path.join(rootDir, '.git'));
  fs.mkdirSync(path.join(rootDir, 'node_modules'));
  fs.mkdirSync(path.join(rootDir, 'supabase/functions/example'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, '.env'), 'SERVICE_ROLE_KEY=do-not-read');
  fs.writeFileSync(path.join(rootDir, 'package.json'), JSON.stringify({ name: 'example', scripts: { test: 'node test.js' }, dependencies: { ws: '^8' } }));
  fs.writeFileSync(path.join(rootDir, 'docker-compose.yml'), 'services:\n  api:\n    image: example\nnetworks:\n  default:\n');
  fs.writeFileSync(path.join(rootDir, 'supabase/functions/example/index.ts'), 'export default {};');
  fs.writeFileSync(path.join(rootDir, 'README.md'), 'example');

  const assessment = createAssessment(rootDir);
  assert.equal(assessment.fileCount, 4);
  assert.deepEqual(assessment.compose, [{ file: 'docker-compose.yml', services: ['api'] }]);
  assert.deepEqual(assessment.supabaseEdgeFunctions, ['example']);
  assert.equal(assessment.files.includes('.env'), false);
  assert.equal(assessment.files.includes('node_modules'), false);
  assert.equal(assessment.secretFilesExcluded, true);
  fs.rmSync(rootDir, { recursive: true, force: true });
});
