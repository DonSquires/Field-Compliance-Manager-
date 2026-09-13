const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const CROSSWALK = [
  { source: 'organizations', target: 'organizations', action: 'candidate_only', approval: 'human_org_match' },
  { source: 'client_sites', target: 'client_sites', action: 'candidate_only', approval: 'human_site_match' },
  { source: 'zones|geo_zones|parking_zones', target: 'location_zones', action: 'candidate_only', approval: 'boundary_and_jurisdiction_review' },
  { source: 'crm_contracts', target: 'service_agreements', action: 'candidate_only', approval: 'agreement_and_party_review' },
  { source: 'observations|breach_alerts', target: 'observations|breach_alerts', action: 'never_auto_promote', approval: 'source_tenant_and_evidence_review' },
  { source: 'canonical_vehicles|canonical_scv', target: 'canonical_vehicles|canonical_scv', action: 'never_auto_promote', approval: 'vehicle_data_governance_review' },
  { source: 'report_templates', target: 'report_templates', action: 'candidate_only', approval: 'template_owner_review' },
  { source: 'storage/*', target: 'file_import_batches|evidence_items', action: 'quarantine_only', approval: 'file_classification_and_hash_review' },
];

const TABLES = [
  'organizations', 'client_sites', 'zones', 'geo_zones', 'parking_zones',
  'observations', 'breach_alerts', 'canonical_vehicles', 'canonical_scv',
  'crm_contracts', 'report_templates',
];
const SOURCE_FILES = [
  'data/client-geofence-registry.json',
  'data/production-geofences.json',
  'data/service-provider-profiles/marlborough-district-council.parking-profile.seed.json',
  'data/service-provider-profiles/nelson-city-council.contract-profile.seed.json',
];
const STORAGE_BUCKETS = ['Parking-Managment', 'Service-Contracts', 'reports', 'contractor-docs'];

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function jsonFetch(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${url}`);
  return response.json();
}

function headers(key) {
  return { apikey: key, Authorization: `Bearer ${key}` };
}

async function tableCount(baseUrl, key, table) {
  const response = await fetch(`${baseUrl}/rest/v1/${table}?select=id&limit=1`, {
    headers: { ...headers(key), Prefer: 'count=exact' },
  });
  if (!response.ok) return { table, available: false, count: null, error: `${response.status} ${response.statusText}` };
  const contentRange = response.headers.get('content-range') ?? '';
  const count = contentRange.includes('/') ? Number(contentRange.split('/')[1]) : null;
  return { table, available: true, count: Number.isFinite(count) ? count : null };
}

async function bucketMetadata(baseUrl, key, bucket) {
  try {
    const objects = await jsonFetch(`${baseUrl}/storage/v1/object/list/${encodeURIComponent(bucket)}`, {
      method: 'POST',
      headers: { ...headers(key), 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefix: '', limit: 1000, offset: 0, sortBy: { column: 'created_at', order: 'desc' } }),
    });
    return {
      bucket,
      objectCount: objects.length,
      objects: objects.map((object) => ({
        name: object.name,
        id: object.id ?? null,
        createdAt: object.created_at ?? null,
        updatedAt: object.updated_at ?? null,
        size: object.metadata?.size ?? null,
        mimeType: object.metadata?.mimetype ?? null,
      })),
    };
  } catch (error) {
    return { bucket, objectCount: null, objects: [], error: error.message };
  }
}

async function sourceHash(repo, ref, file) {
  const url = `https://api.github.com/repos/${repo}/contents/${file}?ref=${encodeURIComponent(ref)}`;
  const response = await fetch(url, { headers: { Accept: 'application/vnd.github.raw+json' } });
  if (!response.ok) return { file, available: false, sha256: null, error: `${response.status} ${response.statusText}` };
  const content = Buffer.from(await response.arrayBuffer());
  return { file, available: true, bytes: content.length, sha256: crypto.createHash('sha256').update(content).digest('hex') };
}

async function main() {
  const supabaseUrl = required('FREEDOM_SUPABASE_URL').replace(/\/$/, '');
  const serviceKey = required('FREEDOM_SUPABASE_SERVICE_ROLE_KEY');
  const sourceRepo = required('FREEDOM_SOURCE_REPO');
  const sourceRef = process.env.FREEDOM_SOURCE_REF || 'main';
  const definitions = await jsonFetch(`${supabaseUrl}/rest/v1/`, { headers: headers(serviceKey) });
  const definitionNames = new Set(Object.keys(definitions.definitions ?? {}));
  const tableCounts = await Promise.all(TABLES.map((table) => tableCount(supabaseUrl, serviceKey, table)));
  const storage = await Promise.all(STORAGE_BUCKETS.map((bucket) => bucketMetadata(supabaseUrl, serviceKey, bucket)));
  const sourceHashes = await Promise.all(SOURCE_FILES.map((file) => sourceHash(sourceRepo, sourceRef, file)));
  const report = {
    generatedAt: new Date().toISOString(),
    mode: 'read_only_import_preview',
    source: { supabaseUrl, sourceRepo, sourceRef, sourceHashes },
    schema: { requestedTables: TABLES, availableTables: TABLES.filter((table) => definitionNames.has(table)), tableCounts },
    storage,
    crosswalk: CROSSWALK,
    promotionPolicy: 'No source record or storage object is promoted. Use file_import_batches and explicit human review before any canonical write.',
  };
  const outputDir = process.env.FREEDOM_IMPORT_PREVIEW_DIR || path.join(process.cwd(), '.bob');
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, 'freedom-import-preview.json');
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ outputPath, generatedAt: report.generatedAt, availableTables: report.schema.availableTables.length, bucketObjects: report.storage.reduce((sum, bucket) => sum + (bucket.objectCount ?? 0), 0), sourceFiles: report.source.sourceHashes.filter((source) => source.available).length }, null, 2));
}

main().catch((error) => {
  console.error(`Freedom import preview failed: ${error.message}`);
  process.exitCode = 1;
});
