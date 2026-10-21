import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const migration = fs.readFileSync('supabase/migrations/20261011054251_document_source_ingestion_runs.sql', 'utf8');
const worker = fs.readFileSync('services/document-source-worker/worker.mjs', 'utf8');
const compose = fs.readFileSync('docker-compose.laptop-worker.yml', 'utf8');
const caddie = fs.readFileSync('supabase/functions/onspace-ai-chat/caddie.ts', 'utf8');
const conductor = fs.readFileSync('supabase/functions/onspace-ai-chat/index.ts', 'utf8');
const endpoint = fs.readFileSync('supabase/functions/bob-document-source-ingestion/index.ts', 'utf8');
const documentDraftEndpoint = fs.readFileSync('supabase/functions/bob-agentic-document-draft/index.ts', 'utf8');
const filesPage = fs.readFileSync('apps/web/src/pages/FileSystemPage.tsx', 'utf8');

test('document source runs are tenant-scoped, resumable, and service-written', () => {
  assert.match(migration, /CREATE TABLE public\.document_source_ingestion_runs/);
  assert.match(migration, /CREATE TABLE public\.document_source_manifest_entries/);
  assert.match(migration, /CREATE TABLE public\.document_source_run_events/);
  assert.match(migration, /FOR UPDATE SKIP LOCKED/);
  assert.match(migration, /lease_token uuid/);
  assert.match(migration, /UNIQUE \(run_id, relative_path\)/);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/g);
  assert.match(migration, /is_admin_for_org\(organization_id\) OR public\.is_grand_master\(\)/);
  assert.match(migration, /GRANT SELECT ON TABLE public\.document_source_manifest_entries TO authenticated/);
  assert.doesNotMatch(migration, /GRANT (INSERT|UPDATE|DELETE).*document_source_manifest_entries TO authenticated/);
  assert.match(migration, /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public\.document_source_manifest_entries TO service_role/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.claim_document_source_ingestion\(text, integer\) FROM PUBLIC/);
});

test('laptop worker resolves one alias and never promotes source files', () => {
  assert.match(worker, /source\.location_ref !== sourceAlias/);
  assert.match(worker, /relative_path: relativePath/);
  assert.match(worker, /hashLimitBytes/);
  assert.match(worker, /capabilityStatus: 'partial'[\s\S]*?hashEligible: false/);
  assert.match(worker, /capability_status: classification\.capabilityStatus/);
  assert.match(worker, /disposition: classification\.disposition/);
  assert.match(worker, /cancel_requested/);
  assert.doesNotMatch(worker, /bob-upsert-generic|bob-proposal-execute|storage\/v1\/object/);
  assert.match(compose, /BOB_DOCUMENT_SOURCE_ALIAS/);
  assert.match(compose, /\/sources\/primary:ro/);
});

test('Bob and the Files workspace expose the governed inventory', () => {
  assert.match(caddie, /inventory_document_source/);
  assert.match(caddie, /bob-document-source-ingestion/);
  assert.match(conductor, /case 'inventory_document_source'/);
  assert.match(conductor, /execInventoryDocumentSource/);
  assert.match(conductor, /Open Files workspace/);
  assert.match(endpoint, /request_document_source_ingestion/);
  assert.match(endpoint, /cancel_document_source_ingestion/);
  assert.match(endpoint, /\.eq\('organization_id', profile\.organization_id\)/);
  assert.match(filesPage, /Bob document inventory/);
  assert.match(filesPage, /Business records are created only through the separate governed promotion lane/);
});

test('Bob can create a governed conversation-scoped document draft', () => {
  assert.match(caddie, /create_document_draft/);
  assert.match(caddie, /bob-agentic-document-draft/);
  assert.match(conductor, /case 'create_document_draft'/);
  assert.match(conductor, /execCreateDocumentDraft/);
  assert.match(conductor, /detectExplicitWriteRefusal\(message(?:: \w+)?, selectedTool = ''\)/);
  assert.match(conductor, /selectedTool === 'create_document_draft'/);
  assert.match(conductor, /scopesRefusalAwayFromDraft/);
  assert.match(conductor, /detectExplicitWriteRefusal\(message, chosenTool\)/);
  assert.match(conductor, /WRITE_CAPABLE_TOOLS[\s\S]*create_document_draft/);
  assert.match(conductor, /studio_artifact_type: 'document'/);
  assert.match(conductor, /studio_artifact_title: title/);
  assert.match(conductor, /studio_artifact_content: authoredText/);
  assert.match(conductor, /Document and version references are protected at your current rank/);
  assert.match(documentDraftEndpoint, /sourceType === 'custom'/);
  assert.match(documentDraftEndpoint, /create_bob_document_draft/);
  assert.match(documentDraftEndpoint, /submit_bob_document_for_review/);
  assert.match(documentDraftEndpoint, /customText\.length > 50_000/);
  assert.match(documentDraftEndpoint, /No business record was promoted|Human verification is required/);
});
