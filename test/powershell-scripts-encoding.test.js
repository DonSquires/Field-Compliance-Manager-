const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');

// Windows PowerShell 5.1 reads a BOM-less .ps1 as Windows-1252, so UTF-8 punctuation such as
// an em dash (E2 80 94) becomes `a`, `EUR`, `"` (a smart quote) and the parser sees a string
// delimiter. That broke laptop-tailscale.ps1 on the owner's laptop on 2026-09-26.
test('PowerShell scripts are pure ASCII or carry a UTF-8 BOM so Windows PowerShell 5.1 parses them', () => {
  // Linked-worktree Git metadata is outside the isolated worker; its manifest comes from the pinned tree.
  const files = process.env.BOB_HEALTH_TRACKED_FILES
    ? JSON.parse(fs.readFileSync(process.env.BOB_HEALTH_TRACKED_FILES, 'utf8')).filter(file => file.endsWith('.ps1'))
    : execFileSync('git', ['ls-files', '*.ps1', '**/*.ps1'], { cwd: root, encoding: 'utf8' }).split('\n').map((f) => f.trim()).filter(Boolean);
  assert.ok(files.length >= 3, `expected the repo's PowerShell scripts, found ${files.length}`);
  for (const file of files) {
    const bytes = fs.readFileSync(path.join(root, file));
    const hasBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
    if (hasBom) continue;
    const offenders = [];
    const lines = bytes.toString('latin1').split('\n');
    lines.forEach((line, index) => { if (/[^\x00-\x7f]/.test(line)) offenders.push(`${index + 1}: ${line.trim().slice(0, 80)}`); });
    assert.deepEqual(offenders, [], `${file} has non-ASCII bytes without a BOM (Windows PowerShell 5.1 will misparse it):\n${offenders.join('\n')}`);
  }
});
