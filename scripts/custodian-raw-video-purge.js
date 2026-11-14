#!/usr/bin/env node
'use strict';

// Evidence Custodian executor for raw CCTV video retention (policy category cctv_raw_video).
// Dry run by default; --apply records each purge through custodian_record_raw_video_purge (which
// rechecks seals, court-ready, holds and the policy) and only then deletes the original recording
// and its playback copy through the Storage API. Evidence rows, frames and decisions are kept.
//
//   node scripts/custodian-raw-video-purge.js --env deploy/laptop-worker/laptop-worker.env
//   node scripts/custodian-raw-video-purge.js --env deploy/laptop-worker/laptop-worker.env --apply

const fs = require('node:fs');

const MAX_BATCHES = 20;

async function runPurge({ rpc, deleteObjects, apply, limit = 100, log = console.log }) {
  const summary = { candidates: 0, purged: 0, failed: 0 };
  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    const candidates = await rpc('custodian_raw_video_purge_candidates', { p_limit: limit });
    if (!candidates.length) break;
    summary.candidates += candidates.length;
    if (!apply) {
      for (const c of candidates) log(`would purge ${c.evidence_id}: ${c.storage_paths.join(', ')}`);
      break;
    }
    let progressed = 0;
    for (const c of candidates) {
      try {
        const recorded = await rpc('custodian_record_raw_video_purge', { p_evidence_id: c.evidence_id });
        await deleteObjects(recorded.storage_bucket, recorded.storage_paths);
        summary.purged += 1;
        progressed += 1;
        log(`purged ${c.evidence_id}`);
      } catch (error) {
        summary.failed += 1;
        log(`skipped ${c.evidence_id}: ${error.message}`);
      }
    }
    if (!progressed) break;
  }
  return summary;
}

function readEnvFile(file) {
  const values = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match) values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return values;
}

async function main(argv = process.argv.slice(2)) {
  const apply = argv.includes('--apply');
  const envIndex = argv.indexOf('--env');
  const limitIndex = argv.indexOf('--limit');
  const fileEnv = envIndex >= 0 ? readEnvFile(argv[envIndex + 1]) : {};
  const url = process.env.SUPABASE_URL || fileEnv.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || fileEnv.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (environment or --env file)');
  const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };

  const rpc = async (fn, args) => {
    const res = await fetch(`${url}/rest/v1/rpc/${fn}`, { method: 'POST', headers, body: JSON.stringify(args) });
    const text = await res.text();
    if (!res.ok) throw new Error(`${fn} ${res.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  };
  const deleteObjects = async (bucket, paths) => {
    const res = await fetch(`${url}/storage/v1/object/${encodeURIComponent(bucket)}`, {
      method: 'DELETE', headers, body: JSON.stringify({ prefixes: paths }),
    });
    if (!res.ok) throw new Error(`storage delete ${res.status}: ${(await res.text()).slice(0, 300)}`);
  };

  const limit = limitIndex >= 0 ? Number(argv[limitIndex + 1]) : 100;
  const summary = await runPurge({ rpc, deleteObjects, apply, limit });
  console.log(`${new Date().toISOString()} ${apply ? 'applied' : 'dry run'}: ${JSON.stringify(summary)}`);
  if (summary.failed) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => { console.error(error.message); process.exit(1); });
}

module.exports = { runPurge, readEnvFile };
