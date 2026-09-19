// Re-run video_motion jobs that completed before the clock-keyed extractor was deployed (worker restart
// 2026-09-19T08:51:12Z). Removes exactly what those jobs wrote — inference_results, entity observations,
// inference-sourced device events, face observations — resets the scene-memory counters those results added,
// clears the jobs' derived caches on the VPS, and requeues them. Evidence rows, hashes, playback copies,
// custody and audit are untouched. Owner-authorised runs only.
//
//   node scripts/rerun-prefix-cctv-jobs.mjs                     # inventory only
//   node scripts/rerun-prefix-cctv-jobs.mjs --apply --before 2026-09-19T08:51:12Z

const PROJECT_REF = process.env.SUPABASE_PROJECT_REF ?? 'dotczcyyzgabmtmnglqj';
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN ?? process.env.FIELD_COMPLIANCE_CODESPACE;
if (!TOKEN) throw new Error('SUPABASE_ACCESS_TOKEN or FIELD_COMPLIANCE_CODESPACE is required');
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const BEFORE = args[args.indexOf('--before') + 1];
if (APPLY && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(BEFORE ?? '')) throw new Error('--apply requires --before <ISO UTC instant the fixed worker started>');
const cutoff = BEFORE ?? '2026-09-19T08:51:12Z';

async function sql(query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
    method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status}: ${text.slice(0, 800)}`);
  return text ? JSON.parse(text) : [];
}

// A job is "pre-fix" when its results were written before the fixed worker started. Jobs still processing
// are left alone: they were claimed by the new worker.
const SCOPE = `rerun AS (
  SELECT j.id, j.evidence_item_id, j.organization_id
    FROM public.inference_jobs j
   WHERE j.domain = 'video_motion' AND j.status = 'complete'
     AND EXISTS (SELECT 1 FROM public.inference_results r WHERE r.inference_job_id = j.id AND r.created_at < '${cutoff}'::timestamptz)
     AND NOT EXISTS (SELECT 1 FROM public.inference_results r WHERE r.inference_job_id = j.id AND r.created_at >= '${cutoff}'::timestamptz))`;

const inventory = await sql(`WITH ${SCOPE}
SELECT 'jobs to re-run' AS item, count(*)::int AS rows FROM rerun
UNION ALL SELECT 'inference_results', count(*)::int FROM public.inference_results WHERE inference_job_id IN (SELECT id FROM rerun)
UNION ALL SELECT 'cctv_entity_observations', count(*)::int FROM public.cctv_entity_observations WHERE inference_job_id IN (SELECT id FROM rerun)
UNION ALL SELECT '  of which human-reviewed (kept)', count(*)::int FROM public.cctv_entity_observations WHERE inference_job_id IN (SELECT id FROM rerun) AND review_state <> 'unreviewed'
UNION ALL SELECT 'face_observations', count(*)::int FROM public.face_observations WHERE evidence_item_id IN (SELECT evidence_item_id FROM rerun)
UNION ALL SELECT 'inference device events (motion windows, quality)', count(*)::int FROM public.cctv_device_events d WHERE d.source = 'inference' AND split_part(d.source_ref, ':', 1) IN (SELECT evidence_item_id::text FROM rerun)
UNION ALL SELECT 'scene profiles touched', count(DISTINCT p.id)::int FROM public.cctv_camera_scene_profiles p JOIN public.evidence_items e ON e.metadata->>'camera_key' = p.camera_key AND e.organization_id = p.organization_id WHERE e.id IN (SELECT evidence_item_id FROM rerun)
UNION ALL SELECT 'jobs completed by the fixed worker (kept)', count(*)::int FROM public.inference_jobs j WHERE j.domain = 'video_motion' AND j.status = 'complete' AND j.id NOT IN (SELECT id FROM rerun)
UNION ALL SELECT 'jobs queued/processing (kept)', count(*)::int FROM public.inference_jobs WHERE domain = 'video_motion' AND status IN ('queued', 'processing')`);
console.log(`Cutoff ${cutoff}${APPLY ? '' : ' (inventory only)'}:`);
for (const row of inventory) console.log(`  ${String(row.item).padEnd(52)} ${row.rows}`);
if (!APPLY) { console.log('\nRun with --apply --before <instant> to re-run these jobs.'); process.exit(0); }

const jobs = await sql(`WITH ${SCOPE} SELECT id FROM rerun`);
const ids = jobs.map((row) => row.id);
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
DELETE FROM public.cctv_entity_observations WHERE inference_job_id IN (SELECT id FROM rerun) AND review_state = 'unreviewed';
DELETE FROM public.face_observations WHERE evidence_item_id IN (SELECT evidence_item_id FROM rerun);
DELETE FROM public.cctv_device_events d WHERE d.source = 'inference' AND split_part(d.source_ref, ':', 1) IN (SELECT evidence_item_id::text FROM rerun);
DELETE FROM public.inference_results WHERE inference_job_id IN (SELECT id FROM rerun);
UPDATE public.inference_jobs SET status = 'queued', stage = 'queued', completed_at = NULL, lease_token = NULL, lease_expires_at = NULL, heartbeat_at = NULL, error_message = NULL,
       progress_percent = 0, progress_current = 0, progress_total = 0, progress_label = 'Re-queued: frame timing corrected'
 WHERE id IN (SELECT id FROM rerun);
UPDATE public.cctv_imports i SET status = 'registered' WHERE i.status = 'review_ready' AND EXISTS (SELECT 1 FROM public.evidence_items e JOIN rerun x ON x.evidence_item_id = e.id WHERE e.cctv_import_id = i.id);
INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
SELECT organization_id, NULL, 'cctv_inference_rerun', 'inference_jobs', id, jsonb_build_object('reason', 'frame timing keyed to container clock (commit 292bcb7)', 'requeued_at', now()) FROM rerun;
COMMIT;`);
console.log('Database reset done. Job ids for cache clearing:');
console.log(ids.join('\n'));
