'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const TEST_SOURCE = /(?:^|\/)[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$/;
const TEST_TITLE = /(?<![\w$.])(?:test|it|describe)(?:\.(?:describe|only|skip|fixme|fail|slow|serial|parallel|concurrent|todo))*\s*\(\s*(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/g;

function patchTouchedPaths(cwd, flags, patchPath) {
  const raw = execFileSync('git', ['apply', '--numstat', '-z', ...flags, patchPath], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024
  });
  const fields = raw.split('\0');
  const paths = [];
  for (let index = 0; index < fields.length; index += 1) {
    const entry = fields[index];
    if (!entry) continue;
    const tab = entry.split('\t');
    if (tab.length >= 3 && tab.slice(2).join('\t') === '') { paths.push(fields[index + 1], fields[index + 2]); index += 2; }
    else paths.push(tab.slice(2).join('\t'));
  }
  const sources = [...fs.readFileSync(patchPath, 'utf8').matchAll(/^(?:rename|copy) from (.+)$/gm)].map((match) => {
    const name = match[1];
    if (!name.startsWith('"')) return name;
    try { return JSON.parse(name); } catch { return name; }
  });
  return [...new Set([...paths, ...sources].filter(Boolean))];
}

function testTitleCounts(content) {
  const counts = new Map();
  for (const match of String(content ?? '').matchAll(TEST_TITLE)) counts.set(match[2], (counts.get(match[2]) || 0) + 1);
  return counts;
}

function droppedPinnedTests({ pinned, current, next }) {
  if (pinned == null) return [];
  const now = current === undefined ? null : testTitleCounts(current);
  const after = testTitleCounts(next);
  const dropped = [];
  for (const [title, count] of testTitleCounts(pinned)) {
    const floor = now ? Math.min(count, now.get(title) || 0) : count;
    if ((after.get(title) || 0) < floor) dropped.push(title);
  }
  return dropped;
}

function droppedTestsMessage(file, dropped) {
  const named = dropped.slice(0, 6).map((title) => JSON.stringify(title)).join(', ');
  return `${file} would remove existing regression tests (${named}${dropped.length > 6 ? `, +${dropped.length - 6} more` : ''})`;
}

/**
 * The verifier's work copy deliberately has no .git, and its read-only source mount is a worktree whose
 * Git metadata stays on the host. The mounted pre-patch source is therefore the baseline: every test file
 * git itself says the patch touches (renames and any path prefix included) must keep its existing titles.
 */
function patchTestPreservationFailures({ beforeDir, afterDir, patchPath }) {
  const touchedTests = patchTouchedPaths(afterDir, [], patchPath).filter(file => TEST_SOURCE.test(file));
  return touchedTests.flatMap(file => {
    const normalized = path.posix.normalize(file);
    if (normalized !== file || path.posix.isAbsolute(file) || normalized.startsWith('../')) return [`${file} is not a safe test path`];
    const beforePath = path.join(beforeDir, file);
    if (!fs.existsSync(beforePath)) return [];
    const afterPath = path.join(afterDir, file);
    const dropped = droppedPinnedTests({
      pinned: fs.readFileSync(beforePath, 'utf8'),
      next: fs.existsSync(afterPath) ? fs.readFileSync(afterPath, 'utf8') : ''
    });
    return dropped.length ? [droppedTestsMessage(file, dropped)] : [];
  });
}

module.exports = {
  TEST_SOURCE,
  droppedPinnedTests,
  droppedTestsMessage,
  patchTouchedPaths,
  patchTestPreservationFailures
};
