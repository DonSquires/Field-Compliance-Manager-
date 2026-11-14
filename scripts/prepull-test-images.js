#!/usr/bin/env node
'use strict';

// Pull the container images the tests run, one at a time and before the tests start.
// Parallel test files pulling inline hit anonymous registry rate limits on shared CI
// runners ("toomanyrequests: Rate exceeded", PR #509); a warm local image never pulls.
// Usage: node scripts/prepull-test-images.js [testDir]

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const IMAGE_LITERAL = /'([a-z0-9][a-z0-9.-]*(?:\/[a-z0-9._-]+)+:[A-Za-z0-9._-]+)'/g;
const NOT_IN_ANY_REGISTRY = /pull access denied|repository does not exist|manifest unknown|not found/i;

function testImages(sources) {
  const images = new Set();
  for (const source of sources) {
    for (const match of source.matchAll(IMAGE_LITERAL)) images.add(match[1]);
  }
  return [...images].sort();
}

function dockerPull(image) {
  const result = spawnSync('docker', ['pull', '--quiet', image], { encoding: 'utf8' });
  return { ok: result.status === 0, output: `${result.stdout || ''}${result.stderr || ''}${result.error ? result.error.message : ''}` };
}

/** Resolves 'pulled' or 'skipped' (a local build tag no registry has); rejects once attempts run out. */
async function pullWithRetry(image, { run = dockerPull, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), attempts = 6, baseDelayMs = 5000 } = {}) {
  let last = '';
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = run(image);
    if (result.ok) return 'pulled';
    last = result.output.trim();
    if (NOT_IN_ANY_REGISTRY.test(last)) return 'skipped';
    if (attempt < attempts) await sleep(baseDelayMs * 2 ** (attempt - 1));
  }
  throw new Error(`could not pull ${image} after ${attempts} attempts: ${last}`);
}

async function main() {
  const dir = path.resolve(process.argv[2] || path.join(__dirname, '..', 'test'));
  const sources = fs.readdirSync(dir).filter(name => name.endsWith('.test.js')).map(name => fs.readFileSync(path.join(dir, name), 'utf8'));
  for (const image of testImages(sources)) {
    const outcome = await pullWithRetry(image);
    console.log(`${outcome}: ${image}`);
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = { testImages, pullWithRetry };
