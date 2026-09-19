// Purge CCTV video data from the live project for a clean test slate: imports, video evidence, inference
// jobs/results, observations, timeline events, review artefacts, bookmarks, scene memory, never-identified
// inference person profiles, and the storage objects behind them. Audit rows are retained and one audit row
// per organisation records the purge. Owner-authorised runs only.
//
//   node scripts/purge-cctv-video-data.mjs                       # inventory only (read-only)
//   node scripts/purge-cctv-video-data.mjs --apply --confirm "purge all cctv video data"
//
// Needs FIELD_COMPLIANCE_CODESPACE (Management API PAT) for SQL and SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
// for storage object deletion (objects must go through the Storage API so the underlying files are removed).

const PROJECT_REF = process.env.SUPABASE_PROJECT_REF ?? 'dotczcyyzgabmtmnglqj';
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN ?? process.env.FIELD_COMPLIANCE_CODESPACE;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!TOKEN) throw new Error('SUPABASE_ACCESS_TOKEN or FIELD_COMPLIANCE_CODESPACE is required');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const CONFIRM = args[args.indexOf('--confirm') + 1];
if (APPLY && CONFIRM !== 'purge all cctv video data') throw new Error('--apply requires --confirm "purge all cctv video data"');
if (APPLY && (!SUPABASE_URL || !SERVICE_KEY)) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required to delete storage objects');

async function sql(query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status}: ${text.slice(0, 800)}`);
  return text ? JSON.parse(text) : [];
}

// Scope: every evidence row the CCTV review module owns (imports and legacy desktop uploads alike), every
// video-motion job, every import, and everything hanging off them.
const SCOPE_CTE = `
  purge_evidence AS (SELECT id, organization_id, storage_path, metadata FROM public.evidence_items WHERE module_key = 'cctv_review'),
  purge_jobs AS (SELECT id FROM public.inference_jobs WHERE domain = 'video_motion' OR evidence_item_id IN (SELECT id FROM purge_evidence)),
  purge_imports AS (SELECT id, organization_id FROM public.cctv_imports),
  purge_people AS (
    SELECT p.id FROM public.person_records p
     WHERE p.metadata->>'origin' = 'cctv_inference_profile' AND p.review_state = 'manual_review_required'
       AND NOT EXISTS (SELECT 1 FROM public.observations o WHERE o.person_record_id = p.id)
       AND NOT EXISTS (SELECT 1 FROM public.persons x WHERE x.person_record_id = p.id)
       AND NOT EXISTS (SELECT 1 FROM public.person_identity_documents d WHERE d.person_record_id = p.id)
  )`;

const INVENTORY = `WITH ${SCOPE_CTE}
SELECT 'cctv_imports' AS item, count(*)::int AS rows FROM purge_imports
UNION ALL SELECT 'evidence_items (cctv_review)', count(*)::int FROM purge_evidence
UNION ALL SELECT '  of which sealed (locked_at set)', count(*)::int FROM public.evidence_items WHERE id IN (SELECT id FROM purge_evidence) AND locked_at IS NOT NULL
UNION ALL SELECT 'inference_jobs (video_motion)', count(*)::int FROM purge_jobs
UNION ALL SELECT '  of which queued/processing', count(*)::int FROM public.inference_jobs WHERE id IN (SELECT id FROM purge_jobs) AND status IN ('queued', 'processing')
UNION ALL SELECT 'inference_results', count(*)::int FROM public.inference_results WHERE inference_job_id IN (SELECT id FROM purge_jobs) OR evidence_item_id IN (SELECT id FROM purge_evidence)
UNION ALL SELECT 'cctv_entity_observations', count(*)::int FROM public.cctv_entity_observations WHERE evidence_item_id IN (SELECT id FROM purge_evidence) OR inference_job_id IN (SELECT id FROM purge_jobs) OR cctv_import_id IN (SELECT id FROM purge_imports)
UNION ALL SELECT 'cctv_device_events', count(*)::int FROM public.cctv_device_events WHERE cctv_import_id IN (SELECT id FROM purge_imports)
UNION ALL SELECT 'cctv_review_events', count(*)::int FROM public.cctv_review_events WHERE evidence_item_id IN (SELECT id FROM purge_evidence) OR inference_job_id IN (SELECT id FROM purge_jobs)
UNION ALL SELECT 'cctv_review_event_decisions', count(*)::int FROM public.cctv_review_event_decisions WHERE review_event_id IN (SELECT id FROM public.cctv_review_events WHERE evidence_item_id IN (SELECT id FROM purge_evidence) OR inference_job_id IN (SELECT id FROM purge_jobs))
UNION ALL SELECT 'cctv_review_decisions', count(*)::int FROM public.cctv_review_decisions WHERE evidence_item_id IN (SELECT id FROM purge_evidence) OR inference_job_id IN (SELECT id FROM purge_jobs)
UNION ALL SELECT 'cctv_identity_drafts', count(*)::int FROM public.cctv_identity_drafts WHERE evidence_item_id IN (SELECT id FROM purge_evidence) OR inference_job_id IN (SELECT id FROM purge_jobs)
UNION ALL SELECT 'cctv_report_receipts', count(*)::int FROM public.cctv_report_receipts WHERE evidence_item_id IN (SELECT id FROM purge_evidence) OR inference_job_id IN (SELECT id FROM purge_jobs)
UNION ALL SELECT 'cctv_exports', count(*)::int FROM public.cctv_exports WHERE evidence_item_id IN (SELECT id FROM purge_evidence) OR inference_job_id IN (SELECT id FROM purge_jobs)
UNION ALL SELECT 'face_observations', count(*)::int FROM public.face_observations WHERE evidence_item_id IN (SELECT id FROM purge_evidence)
UNION ALL SELECT 'incident_attachments (bookmarks)', count(*)::int FROM public.incident_attachments WHERE evidence_item_id IN (SELECT id FROM purge_evidence)
UNION ALL SELECT 'incidents (cctv_bookmark)', count(*)::int FROM public.incidents WHERE incident_type = 'cctv_bookmark'
UNION ALL SELECT 'consumed_job_tokens', count(*)::int FROM public.consumed_job_tokens WHERE inference_job_id IN (SELECT id FROM purge_jobs)
UNION ALL SELECT 'cctv_camera_scene_profiles', count(*)::int FROM public.cctv_camera_scene_profiles
UNION ALL SELECT 'person_records (Unknown Person, never identified, unreferenced)', count(*)::int FROM purge_people
UNION ALL SELECT 'canonical_people behind those profiles', count(*)::int FROM public.canonical_person_links l WHERE l.source_table = 'person_records' AND l.source_id IN (SELECT id FROM purge_people)
UNION ALL SELECT 'storage objects org/*/cctv/** + desktop/**', count(*)::int FROM storage.objects WHERE bucket_id = 'bob-uploads' AND (name LIKE 'org/%/cctv/%' OR name LIKE 'desktop/%')
UNION ALL SELECT 'storage bytes (MB)', (coalesce(sum((metadata->>'size')::bigint), 0) / 1048576)::int FROM storage.objects WHERE bucket_id = 'bob-uploads' AND (name LIKE 'org/%/cctv/%' OR name LIKE 'desktop/%')
UNION ALL SELECT 'NOT in scope: other video evidence', count(*)::int FROM public.evidence_items WHERE evidence_kind = 'video' AND module_key <> 'cctv_review'
UNION ALL SELECT 'NOT in scope: inference_jobs of other domains', count(*)::int FROM public.inference_jobs WHERE domain <> 'video_motion' AND id NOT IN (SELECT id FROM purge_jobs)`;

const BY_ORG = `WITH ${SCOPE_CTE}
SELECT o.name AS organisation, count(DISTINCT i.id)::int AS imports, count(DISTINCT e.id)::int AS videos
  FROM public.organizations o
  LEFT JOIN purge_imports i ON i.organization_id = o.id
  LEFT JOIN purge_evidence e ON e.organization_id = o.id
 GROUP BY o.name HAVING count(i.id) > 0 OR count(e.id) > 0 ORDER BY videos DESC`;

function table(rows) {
  const width = Math.max(...rows.map((r) => String(Object.values(r)[0]).length));
  for (const row of rows) {
    const [label, ...rest] = Object.values(row);
    console.log(`  ${String(label).padEnd(width)}  ${rest.join('  ')}`);
  }
}

const inventory = await sql(INVENTORY);
console.log(APPLY ? 'Before purge:' : 'Inventory (read-only):');
table(inventory);
const byOrg = await sql(BY_ORG);
if (byOrg.length) { console.log('By organisation:'); table(byOrg); }
if (!APPLY) { console.log('\nRun again with --apply --confirm "purge all cctv video data" to remove all of the above.'); process.exit(0); }

// Storage paths are collected before the rows go, and the prefixes swept afterwards for orphans.
const objects = await sql(`SELECT name FROM storage.objects WHERE bucket_id = 'bob-uploads' AND (name LIKE 'org/%/cctv/%' OR name LIKE 'desktop/%') ORDER BY name`);
const paths = objects.map((row) => row.name);

const PURGE = `BEGIN;
SET LOCAL app.evidence_delete_scope = 'test_dataset_purge';
CREATE TEMP TABLE purge_evidence ON COMMIT DROP AS SELECT id, organization_id FROM public.evidence_items WHERE module_key = 'cctv_review';
CREATE TEMP TABLE purge_jobs ON COMMIT DROP AS SELECT id FROM public.inference_jobs WHERE domain = 'video_motion' OR evidence_item_id IN (SELECT id FROM purge_evidence);
CREATE TEMP TABLE purge_imports ON COMMIT DROP AS SELECT id, organization_id FROM public.cctv_imports;
CREATE TEMP TABLE purge_people ON COMMIT DROP AS
  SELECT p.id, p.organization_id FROM public.person_records p
   WHERE p.metadata->>'origin' = 'cctv_inference_profile' AND p.review_state = 'manual_review_required'
     AND NOT EXISTS (SELECT 1 FROM public.observations o WHERE o.person_record_id = p.id)
     AND NOT EXISTS (SELECT 1 FROM public.persons x WHERE x.person_record_id = p.id)
     AND NOT EXISTS (SELECT 1 FROM public.person_identity_documents d WHERE d.person_record_id = p.id);
CREATE TEMP TABLE purge_canonical ON COMMIT DROP AS
  SELECT DISTINCT l.canonical_person_id AS id FROM public.canonical_person_links l WHERE l.source_table = 'person_records' AND l.source_id IN (SELECT id FROM purge_people);
CREATE TEMP TABLE purge_counts ON COMMIT DROP AS
  SELECT o.id AS organization_id,
         (SELECT count(*) FROM purge_imports i WHERE i.organization_id = o.id) AS imports,
         (SELECT count(*) FROM purge_evidence e WHERE e.organization_id = o.id) AS videos,
         (SELECT count(*) FROM public.cctv_entity_observations x WHERE x.organization_id = o.id AND (x.evidence_item_id IN (SELECT id FROM purge_evidence) OR x.inference_job_id IN (SELECT id FROM purge_jobs))) AS observations,
         (SELECT count(*) FROM purge_people p WHERE p.organization_id = o.id) AS unknown_profiles
    FROM public.organizations o
   WHERE EXISTS (SELECT 1 FROM purge_imports i WHERE i.organization_id = o.id) OR EXISTS (SELECT 1 FROM purge_evidence e WHERE e.organization_id = o.id);

DELETE FROM public.cctv_report_receipts WHERE evidence_item_id IN (SELECT id FROM purge_evidence) OR inference_job_id IN (SELECT id FROM purge_jobs);
DELETE FROM public.cctv_exports WHERE evidence_item_id IN (SELECT id FROM purge_evidence) OR inference_job_id IN (SELECT id FROM purge_jobs);
DELETE FROM public.cctv_review_event_decisions WHERE review_event_id IN (SELECT id FROM public.cctv_review_events WHERE evidence_item_id IN (SELECT id FROM purge_evidence) OR inference_job_id IN (SELECT id FROM purge_jobs));
DELETE FROM public.cctv_review_events WHERE evidence_item_id IN (SELECT id FROM purge_evidence) OR inference_job_id IN (SELECT id FROM purge_jobs);
DELETE FROM public.cctv_review_decisions WHERE evidence_item_id IN (SELECT id FROM purge_evidence) OR inference_job_id IN (SELECT id FROM purge_jobs);
DELETE FROM public.cctv_identity_drafts WHERE evidence_item_id IN (SELECT id FROM purge_evidence) OR inference_job_id IN (SELECT id FROM purge_jobs);
DELETE FROM public.cctv_entity_observations WHERE evidence_item_id IN (SELECT id FROM purge_evidence) OR inference_job_id IN (SELECT id FROM purge_jobs) OR cctv_import_id IN (SELECT id FROM purge_imports);
DELETE FROM public.face_observations WHERE evidence_item_id IN (SELECT id FROM purge_evidence);
DELETE FROM public.incident_attachments WHERE evidence_item_id IN (SELECT id FROM purge_evidence);
DELETE FROM public.incidents WHERE incident_type = 'cctv_bookmark';
DELETE FROM public.inference_results WHERE inference_job_id IN (SELECT id FROM purge_jobs) OR evidence_item_id IN (SELECT id FROM purge_evidence);
DELETE FROM public.consumed_job_tokens WHERE inference_job_id IN (SELECT id FROM purge_jobs);
DELETE FROM public.inference_jobs WHERE id IN (SELECT id FROM purge_jobs);
DELETE FROM public.evidence_items WHERE id IN (SELECT id FROM purge_evidence);
DELETE FROM public.cctv_device_events WHERE cctv_import_id IN (SELECT id FROM purge_imports);
DELETE FROM public.cctv_imports WHERE id IN (SELECT id FROM purge_imports);
DELETE FROM public.cctv_camera_scene_profiles;
DELETE FROM public.canonical_person_links WHERE source_table = 'person_records' AND source_id IN (SELECT id FROM purge_people);
DELETE FROM public.person_records WHERE id IN (SELECT id FROM purge_people);
DELETE FROM public.canonical_people c WHERE c.id IN (SELECT id FROM purge_canonical) AND NOT EXISTS (SELECT 1 FROM public.canonical_person_links l WHERE l.canonical_person_id = c.id);

INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
SELECT organization_id, NULL, 'cctv_video_data_purged', 'cctv_imports', NULL,
       jsonb_build_object('reason', 'clean slate before Desktop V2 0.3.0 test', 'imports', imports, 'videos', videos, 'observations', observations, 'unknown_profiles', unknown_profiles, 'storage_objects', ${paths.length}, 'purged_at', now())
  FROM purge_counts;
COMMIT;`;

console.log(`\nDeleting database rows in one transaction…`);
await sql(PURGE);
console.log('Database rows removed.');

// Storage: through the API so the stored files go too; 100 paths per call.
async function removeObjects(batch) {
  const res = await fetch(`${SUPABASE_URL.replace(/\/$/, '')}/storage/v1/object/bob-uploads`, {
    method: 'DELETE',
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefixes: batch }),
  });
  if (!res.ok) throw new Error(`storage delete ${res.status}: ${(await res.text()).slice(0, 300)}`);
}
let removed = 0;
for (let index = 0; index < paths.length; index += 100) {
  await removeObjects(paths.slice(index, index + 100));
  removed += Math.min(100, paths.length - index);
  if (removed % 500 === 0 || removed === paths.length) console.log(`  storage objects removed: ${removed}/${paths.length}`);
}

console.log('\nAfter purge:');
table(await sql(INVENTORY));
