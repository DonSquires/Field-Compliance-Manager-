// Re-run video_motion jobs whose results cannot be trusted. Two scopes:
//   prefix      — completed before the clock-keyed extractor was deployed (worker restart 2026-09-19T08:51:12Z)
//   unexamined  — completed while some sampled frames were never examined by any detector (before commit 6f3c6085
//                 the RunPod circuit breaker skipped whole batches and the job still completed as "no sightings")
//   engine-v2   — completed jobs whose latest result was not produced by cctv-engine-v2 (owner ruling 2026-11-01);
//                 run in batches with --limit, newest first. Human decisions are kept and carried forward by
//                 reconcile_cctv_reviewed_observations when the job re-runs.
// Removes exactly what those jobs wrote — inference_results, entity observations, inference-sourced device events,
// face observations — resets the scene-memory counters those results added, and requeues them; the caller clears
// the jobs' derived caches on the VPS. Evidence rows, hashes, playback copies, custody and audit are untouched.
// Owner-authorised runs only.
//
//   node scripts/rerun-prefix-cctv-jobs.mjs                                   # inventory only (prefix scope)
//   node scripts/rerun-prefix-cctv-jobs.mjs --apply --before 2026-09-19T08:51:12Z
//   node scripts/rerun-prefix-cctv-jobs.mjs --scope unexamined                # inventory only
//   node scripts/rerun-prefix-cctv-jobs.mjs --scope unexamined --apply
//   node scripts/rerun-prefix-cctv-jobs.mjs --scope engine-v2 --limit 25         # inventory only
//   node scripts/rerun-prefix-cctv-jobs.mjs --scope engine-v2 --limit 25 --apply

const PROJECT_REF = process.env.SUPABASE_PROJECT_REF ?? 'dotczcyyzgabmtmnglqj';
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN ?? process.env.FIELD_COMPLIANCE_CODESPACE;
if (!TOKEN) throw new Error('SUPABASE_ACCESS_TOKEN or FIELD_COMPLIANCE_CODESPACE is required');
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const SCOPE_NAME = args.includes('--scope') ? args[args.indexOf('--scope') + 1] : 'prefix';
if (!['prefix', 'unexamined', 'engine-v2'].includes(SCOPE_NAME)) throw new Error('--scope must be prefix, unexamined or engine-v2');
const LIMIT = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : undefined;
if (LIMIT !== undefined && (!Number.isInteger(LIMIT) || LIMIT < 1 || LIMIT > 500)) throw new Error('--limit must be a whole number from 1 to 500');
if (LIMIT !== undefined && SCOPE_NAME !== 'engine-v2') throw new Error('--limit applies only to --scope engine-v2');
if (SCOPE_NAME === 'engine-v2' && APPLY && LIMIT === undefined) throw new Error('--scope engine-v2 --apply requires --limit <batch size>');
const BEFORE = args.includes('--before') ? args[args.indexOf('--before') + 1] : undefined;
if (SCOPE_NAME === 'prefix' && APPLY && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(BEFORE ?? '')) throw new Error('--apply requires --before <ISO UTC instant the fixed worker started>');
const cutoff = BEFORE ?? '2026-09-19T08:51:12Z';

async function sql(query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
    method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status}: ${text.slice(0, 800)}`);
  return text ? JSON.parse(text) : [];
}

// prefix: a job is "pre-fix" when its results were written before the fixed worker started. Jobs still processing
// are left alone: they were claimed by the new worker.
const PREFIX_SCOPE = `rerun AS (
  SELECT j.id, j.evidence_item_id, j.organization_id
    FROM public.inference_jobs j
   WHERE j.domain = 'video_motion' AND j.status = 'complete'
     AND EXISTS (SELECT 1 FROM public.inference_results r WHERE r.inference_job_id = j.id AND r.created_at < '${cutoff}'::timestamptz)
     AND NOT EXISTS (SELECT 1 FROM public.inference_results r WHERE r.inference_job_id = j.id AND r.created_at >= '${cutoff}'::timestamptz))`;
// unexamined: the latest result's plan shows frames no detector looked at. Results written by the vps_first
// worker carry `coverage.frames_untriaged` (always 0 on a completed job); older results only metered GPU sends,
// so there the gap is sampled minus sent.
const UNEXAMINED_SCOPE = `rerun AS (
  SELECT j.id, j.evidence_item_id, j.organization_id
    FROM public.inference_jobs j
    JOIN LATERAL (SELECT result FROM public.inference_results r WHERE r.inference_job_id = j.id ORDER BY created_at DESC LIMIT 1) r ON true
   WHERE j.domain = 'video_motion' AND j.status = 'complete'
     AND coalesce((r.result->'classification_plan'->'coverage'->>'frames_untriaged')::int,
                  coalesce((r.result->'classification_plan'->>'sampled_frames')::int, 0) - coalesce((r.result->'classification_plan'->'usage'->>'frames_sent')::int, 0)) > 0)`;
// engine-v2: the latest result's model manifest does not name cctv-engine-v2. Newest first, one batch at a time,
// so the GPU tier is never flooded and each batch can be checked before the next.
const ENGINE_V2_SCOPE = `rerun AS (
  SELECT j.id, j.evidence_item_id, j.organization_id
    FROM public.inference_jobs j
    JOIN LATERAL (SELECT result FROM public.inference_results r WHERE r.inference_job_id = j.id ORDER BY created_at DESC LIMIT 1) r ON true
   WHERE j.domain = 'video_motion' AND j.status = 'complete'
     AND (r.result #>> '{classification_plan,model_manifest,engine_version}') IS DISTINCT FROM 'cctv-engine-v2'
   ORDER BY j.created_at DESC, j.id
   ${LIMIT === undefined ? '' : `LIMIT ${LIMIT}`})`;
const SCOPES = {
  prefix: {
    sql: PREFIX_SCOPE,
    label: 'Re-queued: frame timing corrected',
    reason: 'frame timing keyed to container clock (commit 292bcb7)',
  },
  unexamined: {
    sql: UNEXAMINED_SCOPE,
    label: 'Re-queued: sampled frames were never examined by a detector',
    reason: 'sampled frames skipped by the RunPod circuit breaker; re-run under vps_first (commit 6f3c6085)',
  },
  'engine-v2': {
    sql: ENGINE_V2_SCOPE,
    label: 'Re-queued: reprocessing with the enterprise CCTV engine',
    reason: 'reprocess with cctv-engine-v2 under the gpu_consistent policy (owner ruling 2026-11-01); human decisions kept',
  },
};
const SCOPE = SCOPES[SCOPE_NAME].sql;
const REQUEUE_LABEL = SCOPES[SCOPE_NAME].label;
const AUDIT_REASON = SCOPES[SCOPE_NAME].reason;
// A superseded source row whose unreviewed anchor is about to be deleted would point at nothing; it goes with it.
// Superseded rows that point at a reviewed sighting are provenance for a human decision and are kept.
const ORPHANED_SUPERSEDED = `public.cctv_entity_observations s
   WHERE s.inference_job_id IN (SELECT id FROM rerun) AND s.review_state = 'superseded'
     AND EXISTS (SELECT 1 FROM public.cctv_entity_observations a
                  WHERE a.id::text = s.attributes->>'superseded_by_observation_id'
                    AND a.review_state = 'unreviewed' AND a.inference_job_id IN (SELECT id FROM rerun))`;

const inventory = await sql(`WITH ${SCOPE}
SELECT 'jobs to re-run' AS item, count(*)::int AS rows FROM rerun
UNION ALL SELECT 'inference_results', count(*)::int FROM public.inference_results WHERE inference_job_id IN (SELECT id FROM rerun)
UNION ALL SELECT 'cctv_entity_observations', count(*)::int FROM public.cctv_entity_observations WHERE inference_job_id IN (SELECT id FROM rerun)
UNION ALL SELECT '  of which human-reviewed (kept)', count(*)::int FROM public.cctv_entity_observations WHERE inference_job_id IN (SELECT id FROM rerun) AND review_state NOT IN ('unreviewed', 'superseded')
UNION ALL SELECT '  of which superseded sources of deleted rows', count(*)::int FROM ${ORPHANED_SUPERSEDED}
UNION ALL SELECT 'face_observations', count(*)::int FROM public.face_observations WHERE evidence_item_id IN (SELECT evidence_item_id FROM rerun)
UNION ALL SELECT 'inference device events (motion windows, quality)', count(*)::int FROM public.cctv_device_events d WHERE d.source = 'inference' AND split_part(d.source_ref, ':', 1) IN (SELECT evidence_item_id::text FROM rerun)
UNION ALL SELECT 'scene profiles touched', count(DISTINCT p.id)::int FROM public.cctv_camera_scene_profiles p JOIN public.evidence_items e ON e.metadata->>'camera_key' = p.camera_key AND e.organization_id = p.organization_id WHERE e.id IN (SELECT evidence_item_id FROM rerun)
UNION ALL SELECT 'jobs completed and kept', count(*)::int FROM public.inference_jobs j WHERE j.domain = 'video_motion' AND j.status = 'complete' AND j.id NOT IN (SELECT id FROM rerun)
UNION ALL SELECT 'jobs queued/processing (kept)', count(*)::int FROM public.inference_jobs WHERE domain = 'video_motion' AND status IN ('queued', 'processing')`);
console.log(`Scope ${SCOPE_NAME}${SCOPE_NAME === 'prefix' ? `, cutoff ${cutoff}` : ''}${LIMIT === undefined ? '' : `, batch ${LIMIT}`}${APPLY ? '' : ' (inventory only)'}:`);
for (const row of inventory) console.log(`  ${String(row.item).padEnd(52)} ${row.rows}`);
if (!APPLY) { console.log(`\nRun with --apply${SCOPE_NAME === 'prefix' ? ' --before <instant>' : ''}${SCOPE_NAME === 'engine-v2' ? ' --limit <batch size>' : ''} to re-run these jobs.`); process.exit(0); }

const jobs = await sql(`WITH ${SCOPE} SELECT id FROM rerun`);
const ids = jobs.map((row) => row.id);
if (SCOPE_NAME === 'engine-v2') {
  // The engine-v2 worker calls these after writing observations; requeueing before they exist fails every job.
  const [ready] = await sql(`SELECT to_regprocedure('public.reconcile_cctv_reviewed_observations(uuid)') IS NOT NULL
    AND to_regprocedure('public.link_cctv_resident_vehicle_observations(uuid)') IS NOT NULL AS ready`);
  if (!ready?.ready) throw new Error('Apply migration 20261102140000_cctv_enterprise_inference and redeploy the watcher before reprocessing');
}
console.log(`\nRe-running ${ids.length} jobs…`);
await sql(`BEGIN;
CREATE TEMP TABLE rerun ON COMMIT DROP AS WITH ${SCOPE} SELECT * FROM rerun;
-- Undo the scene-memory increments these results made (evidence_count and the summed event counts).
WITH contributions AS (
  SELECT e.organization_id, e.metadata->>'camera_key' AS camera_key,
         count(*)::int AS evidence_n,
         sum(coalesce(jsonb_array_length(r.result #> '{consolidated_events,vehicle_events}'), 0))::int AS vehicle_n,
         sum(coalesce(jsonb_array_length(r.result #> '{consolidated_events,person_events}'), 0) + coalesce(jsonb_array_length(r.result #> '{consolidated_events,face_events}'), 0))::int AS person_n,
         sum(coalesce((r.result #>> '{consolidated_events,quality_summary,review_required_count}')::int, 0))::int AS review_n
    FROM rerun x JOIN public.evidence_items e ON e.id = x.evidence_item_id
    JOIN LATERAL (SELECT result FROM public.inference_results r WHERE r.inference_job_id = x.id ORDER BY created_at DESC LIMIT 1) r ON true
   GROUP BY 1, 2)
UPDATE public.cctv_camera_scene_profiles p
   SET evidence_count = greatest(0, p.evidence_count - c.evidence_n),
       recidivism_summary = jsonb_build_object(
         'vehicle_events', greatest(0, coalesce((p.recidivism_summary->>'vehicle_events')::int, 0) - c.vehicle_n),
         'person_events', greatest(0, coalesce((p.recidivism_summary->>'person_events')::int, 0) - c.person_n),
         'review_required', greatest(0, coalesce((p.recidivism_summary->>'review_required')::int, 0) - c.review_n))
  FROM contributions c WHERE c.organization_id = p.organization_id AND c.camera_key = p.camera_key;
DELETE FROM ${ORPHANED_SUPERSEDED};
DELETE FROM public.cctv_entity_observations WHERE inference_job_id IN (SELECT id FROM rerun) AND review_state = 'unreviewed';
DELETE FROM public.face_observations WHERE evidence_item_id IN (SELECT evidence_item_id FROM rerun);
DELETE FROM public.cctv_device_events d WHERE d.source = 'inference' AND split_part(d.source_ref, ':', 1) IN (SELECT evidence_item_id::text FROM rerun);
DELETE FROM public.inference_results WHERE inference_job_id IN (SELECT id FROM rerun);
UPDATE public.inference_jobs SET status = 'queued', stage = 'queued', completed_at = NULL, lease_token = NULL, lease_expires_at = NULL, heartbeat_at = NULL, error_message = NULL,
       progress_percent = 0, progress_current = 0, progress_total = 0, progress_label = '${REQUEUE_LABEL}'
 WHERE id IN (SELECT id FROM rerun);
UPDATE public.cctv_imports i SET status = 'registered' WHERE i.status = 'review_ready' AND EXISTS (SELECT 1 FROM public.evidence_items e JOIN rerun x ON x.evidence_item_id = e.id WHERE e.cctv_import_id = i.id);
INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
SELECT organization_id, NULL, 'cctv_inference_rerun', 'inference_jobs', id, jsonb_build_object('reason', '${AUDIT_REASON}', 'scope', '${SCOPE_NAME}', 'requeued_at', now()) FROM rerun;
COMMIT;`);
console.log('Database reset done. Job ids for cache clearing:');
console.log(ids.join('\n'));
