#!/usr/bin/env node
'use strict';

// Pull the container images the tests run, one at a time and before the tests start.
// Parallel test files pulling inline hit anonymous registry rate limits on shared CI
// runners ("toomanyrequests: Rate exceeded", PR #509); a warm local image never pulls.
// ECR hard data quotas cannot be cured by backoff. These official mirrors have
// identical OCI index digests; pin the artifact, never substitute another version.
// Usage: node scripts/prepull-test-images.js [testDir]

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const IMAGE_LITERAL = /'([a-z0-9][a-z0-9.-]*(?:\/[a-z0-9._-]+)+:[A-Za-z0-9._-]+)'/g;
const NOT_IN_ANY_REGISTRY = /pull access denied|repository does not exist|manifest unknown|not found/i;
const REGISTRY_QUOTA = /toomanyrequests|rate.?limit|rate exceeded|data limit exceeded/i;
const OFFICIAL_MIRRORS = new Map([
  ['public.ecr.aws/supabase/postgres:17.11.0.004',
    'docker.io/supabase/postgres@sha256:b15d862126dd2dac02da524696ccfde2dcce2ceaee0a58973b2727befe492706'],
  ['public.ecr.aws/supabase/postgrest:v14.5',
    'docker.io/postgrest/postgrest@sha256:b574528fe109c8343c1247155734d03df8c34b462f342dca0ccc20244fc36ef9'],
]);

function testImages(sources) {
  const images = new Set();
  for (const source of sources) {
    for (const match of source.matchAll(IMAGE_LITERAL)) images.add(match[1]);
  }
  return [...images].sort();
}

function dockerPull(image, execute = spawnSync) {
  const docker = args => {
    const result = execute('docker', args, { encoding: 'utf8' });
    return { ok: result.status === 0, output: `${result.stdout || ''}${result.stderr || ''}${result.error ? result.error.message : ''}` };
  };
  const primary = docker(['pull', '--quiet', image]);
  const mirror = OFFICIAL_MIRRORS.get(image);
  if (primary.ok || !mirror || !REGISTRY_QUOTA.test(primary.output)) return primary;
  const pulled = docker(['pull', '--quiet', mirror]);
  if (!pulled.ok) return { ok: false, output: `${primary.output}\nOfficial mirror ${mirror}: ${pulled.output}` };
  const tagged = docker(['tag', mirror, image]);
  if (!tagged.ok) return { ok: false, output: `Could not tag official mirror ${mirror} as ${image}: ${tagged.output}` };
  return { ...tagged, mirror };
}

/** Resolves 'pulled' or 'skipped' (a local build tag no registry has); rejects once attempts run out. */
async function pullWithRetry(image, { run = dockerPull, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), attempts = 6, baseDelayMs = 5000 } = {}) {
  let last = '';
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = run(image);
    if (result.ok) {
      if (result.mirror) console.log(`official mirror: ${result.mirror} -> ${image}`);
      return 'pulled';
    }
    last = result.output.trim();
    if (image.startsWith('fcm/') && NOT_IN_ANY_REGISTRY.test(last)) return 'skipped';
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

module.exports = { testImages, pullWithRetry, dockerPull };
