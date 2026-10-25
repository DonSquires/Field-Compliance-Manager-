#!/usr/bin/env node
// Seeds planner-approved historical patrol-log labour into roster_slots through the governed
// import_historical_patrol_labour_slots RPC, acting as the R&M import automation profile.
// Rolls back by default. --commit requires the owner-approved planner fingerprint.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLabourReport, runLinkedSql } from './preview-rm-patrol-labour.mjs';

const PROVIDER = 'e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13';
const IMPORT_ACTOR = 'f1c00000-0000-4000-8000-000000000001';
const MAX_BATCH = 1000;
const HEX64 = /^[0-9a-f]{64}$/;

export function batchRequestId(reportFingerprint, index) {
  const hex = createHash('sha256').update(`rm_patrol_log_labour|${reportFingerprint}|${index}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const dollarQuote = (text, tag) => {
  if (text.includes(`$${tag}$`)) throw new Error('Payload collides with its SQL quote tag');
  return `$${tag}$${text}$${tag}$`;
};

export function importSql({ slots, reportFingerprint, batchSize = 500, commit = false, migrationSql = '' }) {
  if (!HEX64.test(reportFingerprint)) throw new Error('A planner report fingerprint is required');
  if (!Array.isArray(slots) || !slots.length) throw new Error('No roster slots are planned');
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH) throw new Error(`Batch size must be 1-${MAX_BATCH}`);
  if (commit && migrationSql) throw new Error('A migration preview can never be committed');
  const calls = [];
  for (let start = 0, index = 0; start < slots.length; start += batchSize, index += 1) {
    const batch = JSON.stringify(slots.slice(start, start + batchSize));
    calls.push(`INSERT INTO pg_temp.labour_receipts VALUES (${index}, public.import_historical_patrol_labour_slots(
  '${PROVIDER}'::uuid, '${batchRequestId(reportFingerprint, index)}'::uuid, '${reportFingerprint}', ${dollarQuote(batch, 'slots')}::jsonb));`);
  }
  return `BEGIN;
SET LOCAL statement_timeout='300s';
${migrationSql}
SELECT set_config('request.jwt.claim.sub','${IMPORT_ACTOR}',true),
  set_config('request.jwt.claims','{"sub":"${IMPORT_ACTOR}","role":"authenticated"}',true);
CREATE TEMP TABLE labour_receipts(batch integer, receipt jsonb) ON COMMIT DROP;
${calls.join('\n')}
SELECT jsonb_build_object(
  'mode', ${commit ? "'commit'" : "'rollback'"},
  'batches', (SELECT count(*) FROM pg_temp.labour_receipts),
  'inserted', (SELECT sum((receipt->>'inserted')::integer) FROM pg_temp.labour_receipts),
  'unchanged', (SELECT sum((receipt->>'unchanged')::integer) FROM pg_temp.labour_receipts),
  'replayed_batches', (SELECT count(*) FROM pg_temp.labour_receipts WHERE (receipt->>'replayed')::boolean),
  'changed_source', (SELECT coalesce(jsonb_agg(c), '[]'::jsonb) FROM pg_temp.labour_receipts, jsonb_array_elements(receipt->'changed_source') c),
  'labour_slots', (SELECT count(*) FROM public.roster_slots WHERE organization_id='${PROVIDER}'::uuid AND external_refs->>'source'='rm_patrol_log_labour'),
  'labour_hours', (SELECT round(sum(extract(epoch FROM scheduled_end-scheduled_start))/3600.0, 4) FROM public.roster_slots
    WHERE organization_id='${PROVIDER}'::uuid AND external_refs->>'source'='rm_patrol_log_labour'),
  'work_units', (SELECT count(*) FROM public.roster_work_units WHERE organization_id='${PROVIDER}'::uuid AND external_refs->>'source'='rm_patrol_log_labour'),
  'pay', (SELECT jsonb_build_object('slots', count(*), 'pay_cost', sum(l.pay_cost), 'billable', sum(l.billable))
      FROM public.get_roster_labour_cost('${PROVIDER}'::uuid, '1900-01-01'::timestamptz, now()) l
      JOIN public.roster_slots s ON s.id = l.slot_id AND s.external_refs->>'source'='rm_patrol_log_labour'),
  'rate_statuses', (SELECT jsonb_object_agg(rate_status, n) FROM (SELECT l.rate_status, count(*) n
      FROM public.get_roster_labour_cost('${PROVIDER}'::uuid, '1900-01-01'::timestamptz, now()) l
      JOIN public.roster_slots s ON s.id = l.slot_id AND s.external_refs->>'source'='rm_patrol_log_labour'
      GROUP BY l.rate_status) x)
) AS result;
${commit ? 'COMMIT;' : 'ROLLBACK;'}`;
}

function parseArgs(args) {
  const values = { '--batch': '500' };
  const flags = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key === '--commit') { flags.add(key); continue; }
    if (!['--from', '--to', '--batch', '--expect-fingerprint', '--with-migration'].includes(key) || !args[index + 1]) {
      throw new Error('Usage: --from YYYY-MM-DD --to YYYY-MM-DD [--batch N] [--with-migration <file>] [--commit --expect-fingerprint <hex>]');
    }
    values[key] = args[index += 1];
  }
  return { values, commit: flags.has('--commit') };
}

export function main(args) {
  const { values, commit } = parseArgs(args);
  if (commit && !HEX64.test(values['--expect-fingerprint'] ?? '')) {
    throw new Error('--commit requires --expect-fingerprint with the owner-approved planner fingerprint');
  }
  const report = loadLabourReport(values['--from'], values['--to']);
  if (values['--expect-fingerprint'] && values['--expect-fingerprint'] !== report.source_fingerprint) {
    throw new Error(`Source data changed since approval (now ${report.source_fingerprint}); re-run the preview and re-approve`);
  }
  const migrationSql = values['--with-migration'] ? readFileSync(path.resolve(values['--with-migration']), 'utf8') : '';
  const sql = importSql({
    slots: report.slots, reportFingerprint: report.source_fingerprint,
    batchSize: Number(values['--batch']), commit, migrationSql,
  });
  const result = runLinkedSql(sql, 'fcm-labour-apply-').rows?.[0]?.result;
  if (!result) throw new Error('The import returned no receipt');
  const expected = report.summary.roster_slots_planned;
  if (result.inserted + result.unchanged + result.changed_source.length !== expected) {
    throw new Error(`Receipt does not reconcile to ${expected} planned slots`);
  }
  console.log(JSON.stringify({ planned: report.summary, source_fingerprint: report.source_fingerprint, result }, null, 2));
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch (error) {
    console.error(`Historical labour import failed: ${error.message}`);
    process.exitCode = 1;
  }
}
