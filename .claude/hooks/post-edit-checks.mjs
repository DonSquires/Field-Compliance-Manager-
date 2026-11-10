#!/usr/bin/env node
// Claude Code PostToolUse fast checks. Path-to-command mapping lives in policy.json postEditChecks.
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadPolicy, projectDirFrom, repoRelative } from './lib.mjs';

export function checksFor(relativePath, policy) {
  if (relativePath == null) return [];
  const seen = new Set();
  return policy.postEditChecks.filter((check) => {
    if (!check.regex.test(relativePath) || seen.has(check.command)) return false;
    seen.add(check.command);
    return true;
  });
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let input;
  try {
    input = JSON.parse(raw || '{}');
  } catch {
    return;
  }
  const projectDir = projectDirFrom(input);
  const target = input?.tool_input?.file_path || input?.tool_input?.notebook_path;
  const relative = repoRelative(target, projectDir, input.cwd || projectDir);
  const failures = [];
  for (const check of checksFor(relative, loadPolicy())) {
    const run = spawnSync(check.command, { cwd: projectDir, shell: true, encoding: 'utf8', timeout: 170000 });
    if (run.status !== 0) {
      const output = `${run.stdout || ''}${run.stderr || ''}`.trim().split(/\r?\n/).slice(-20).join('\n');
      failures.push(`${check.label || check.command} failed after editing ${relative} (${check.command}):\n${output}`);
    }
  }
  if (failures.length) process.stdout.write(JSON.stringify({ decision: 'block', reason: failures.join('\n\n') }));
}

const invokedDirectly = (() => {
  try {
    return realpathSync(process.argv[1] || '') === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (invokedDirectly) await main();
