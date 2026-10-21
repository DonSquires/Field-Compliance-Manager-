const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

// The worker image copies an explicit file list. When a worker entrypoint (or
// anything it requires) gains a new local dependency that is not copied, every
// backend/frontend/security verification fails inside the container with
// MODULE_NOT_FOUND before writing any evidence — which is exactly how the first
// Bob self-heal run died on 2026-09-26. This test keeps the list honest.

const ROOT = path.resolve(__dirname, '..');
const ENTRYPOINTS = ['assessment-manifest.js', 'frontend-worker.js', 'backend-worker.js', 'security-worker.js', 'visual-baseline-worker.js'];

function localRequireClosure(entrypoints) {
  const seen = new Set();
  const queue = [...entrypoints];
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    const absolute = path.join(ROOT, ...file.split('/'));
    assert.ok(fs.existsSync(absolute), `worker dependency is missing from the repo: ${file}`);
    seen.add(file);
    const source = fs.readFileSync(absolute, 'utf8');
    for (const match of source.matchAll(/require\((?:'|")(\.[^'"]+)(?:'|")\)/g)) {
      let dependency = path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1].replace(/\\/g, '/')));
      if (!/\.(?:c?js|json)$/.test(dependency)) dependency += '.js';
      queue.push(dependency);
    }
  }
  return [...seen].sort();
}

function copiedFiles(dockerfile) {
  const copied = new Set();
  for (const line of dockerfile.split('\n')) {
    const match = line.match(/^COPY\s+(.+?)\s+\/opt\/bob\/(\S+)\s*$/);
    if (!match) continue;
    const sources = match[1].trim().split(/\s+/);
    const destination = match[2];
    for (const source of sources) {
      // Single-file copies must land at the same relative path so require() resolves.
      if (sources.length === 1) copied.add(destination === source ? source : `${source} -> ${destination}`);
    }
  }
  return copied;
}

test('Dockerfile.worker copies every local module reachable from the worker entrypoints', () => {
  const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile.worker'), 'utf8');
  const copied = copiedFiles(dockerfile);
  const missing = localRequireClosure(ENTRYPOINTS).filter(file => !copied.has(file));
  assert.deepEqual(missing, [], `add COPY lines to Dockerfile.worker for: ${missing.join(', ')}`);
});

test('worker entrypoints are copied to the same relative path they have in the repo', () => {
  const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile.worker'), 'utf8');
  const relocated = [...copiedFiles(dockerfile)].filter(entry => entry.includes(' -> '));
  assert.deepEqual(relocated, [], `relative require() paths break when files move: ${relocated.join(', ')}`);
});
