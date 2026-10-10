import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const page = readFileSync(resolve(process.cwd(), 'src/pages/FileSystemPage.tsx'), 'utf8');
const shell = readFileSync(resolve(process.cwd(), 'src/shells/AdminShell.tsx'), 'utf8');
const folderMigration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260927190000_file_explorer_folders.sql'), 'utf8');

describe('organisation file system', () => {
  it('reads the canonical document and version spine within tenant scope', () => {
    expect(page).toContain(".from('documents')");
    expect(page).toContain(".from('document_versions')");
    expect(page).toContain('operatingOrganizationId ?? profile?.organizationId');
    expect(page).toContain('organization_id.is.null');
  });

  it('opens files only through short-lived signed storage URLs', () => {
    expect(page).toContain('createSignedUrl');
    expect(page).toContain('900');
    expect(page).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
  });

  it('uses a persistent Explorer hierarchy with governed folder and move actions', () => {
    expect(page).toContain("rpc('get_file_explorer_tree'");
    expect(page).toContain("rpc('create_file_folder'");
    expect(page).toContain("rpc('move_document_to_folder'");
    expect(page).toContain('<FileExplorerTree');
    expect(page).not.toContain('const FILE_SPACES');
    expect(page).not.toContain('function spaceFor(');
    expect(folderMigration).toContain('CREATE TABLE IF NOT EXISTS public.file_spaces');
    expect(folderMigration).toContain('CREATE TABLE IF NOT EXISTS public.file_folders');
    expect(folderMigration).toContain('CREATE TABLE IF NOT EXISTS public.document_placements');
    expect(folderMigration).toContain('CREATE TRIGGER trg_file_organization_tree');
    expect(folderMigration).toContain('CREATE TRIGGER trg_file_location_folder');
    expect(folderMigration).toContain('CREATE TRIGGER trg_file_person_folder');
    expect(folderMigration).toContain("'Company records'");
    expect(folderMigration).toContain("'Health & safety'");
    expect(folderMigration).toContain('file_restricted_access_allowed');
    expect(folderMigration).toContain("actor.role IN('grand_master','master','admin')");
    expect(folderMigration).not.toContain("p_sensitivity <> 'restricted' OR public.is_admin_for_org");
    expect(folderMigration).toContain('DROP POLICY IF EXISTS documents_select');
    expect(folderMigration).toContain('public.file_space_access_allowed(space.organization_id,space.sensitivity)');
  });

  it('surfaces generated document outputs as a first-class governed registry', () => {
    expect(page).toContain("from('bob_generated_document_outputs')");
    expect(page).toContain('Generated outputs');
    expect(page).toContain('Generated output status');
    expect(page).toContain('Generated output format');
    expect(page).toContain('renderer_version');
    expect(page).toContain('mime_type');
    expect(page).toContain('approved_at');
    expect(page).toContain('SHA-256');
    expect(page).toContain('documents(original_filename,source_channel,current_scope)');
    expect(page).toContain('document_versions(version_label,metadata_json)');
    expect(page).toContain('GeneratedArtifactActions bucket={output.storage_bucket}');
    expect(page).toContain('artifactFileName(outputTitle(output), extension)');
  });

  it('surfaces enforcement notices separately from Bob-generated outputs', () => {
    expect(page).toContain("from('notices_to_vacate')");
    expect(page).toContain("from('infringement_notices')");
    expect(page).toContain('bucket="notice-artifacts"');
    expect(page).toContain('Enforcement notice artifacts');
    expect(page).toContain('GeneratedArtifactActions bucket="notice-artifacts"');
    expect(page).toContain("'PDF artifact'");
    expect(page).toContain('eq(\'organization_id\', organizationId)');
  });

  it('loads Bob classification provenance without promoting records automatically', () => {
    expect(page).toContain('document_classifications');
    expect(page).toContain('classifier_source');
    expect(page).toContain('Promotion is deliberately separate from file storage');
  });

  it('hands promotion decisions to the governed approvals workspace', () => {
    expect(page).toContain("navigate('/admin/approvals')");
    expect(page).toContain('Review promotions');
    expect(page).not.toContain("functions.invoke('bob-document-promote'");
  });

  it('registers Bob intake through the governed document edge function', () => {
    expect(page).toContain("from('bob_attachments')");
    expect(page).toContain("functions.invoke('bob-document-register'");
    expect(page).toContain('Register in Files');
    expect(page).not.toMatch(/from\('(documents|document_versions)'\)[\s\S]{0,240}\.(insert|update|upsert|delete)\(/);
  });

  it('provides a visible one-file browser intake path through private storage and registration', () => {
    expect(page).toContain('Upload source file');
    expect(page).toContain("supabase.storage.from('bob-uploads').upload");
    expect(page).toContain("supabase.from('bob_attachments').insert");
    expect(page).toContain(".eq('module_key', 'operations')");
    expect(page).toContain("title: 'Bob Operations'");
    expect(page).not.toContain('conversation_id: null');
    expect(page).toContain("supabase.functions.invoke('bob-document-register'");
    expect(page).toContain('uploaded through the human intake path');
  });

  it('quarantines unsafe, partial, and unknown intake artifacts before registration', () => {
    expect(page).toContain('Unsupported or unsafe artifact');
    expect(page).toContain('Office lock file');
    expect(page).toContain('Quarantined:');
  });

  it('previews only a human-selected import file before promotion', () => {
    expect(page).toContain('Import preview');
    expect(page).toContain('Structured data imports');
    expect(page).toContain('Choose a CSV or XLSX file');
    expect(page).toContain('No structured file selected.');
    expect(page).not.toContain('SAMPLE_MANIFEST_PREVIEW');
    expect(page).not.toContain('SAMPLE_IMPORT_PREVIEWS');
    expect(page).not.toContain('sample-data-2026-09-08');
    expect(page).not.toContain('Vehicle Log (1).csv');
    expect(page).toContain('Column mapping');
    expect(page).toContain('Duplicate rows');
    expect(page).toContain('Unresolved values');
    expect(page).toContain("rpc('create_file_import_batch'");
    expect(page).toContain('Create review batch');
    expect(page).toContain('No canonical records were changed');
    expect(page).toContain("from('file_import_batches')");
    expect(page).toContain('Import batch status');
    expect(page).toContain('Review history');
    expect(page).toContain("rpc('review_file_import_batch'");
    expect(page).toContain('Approve batch');
    expect(page).toContain('Reject batch');
    expect(page).toContain('A review reason is required');
    expect(page).toContain('sha256Hex');
    expect(page).toContain('p_source_sha256');
    expect(page).toContain('SHA-256');
    expect(page).toContain('duplicate_of_batch_id');
    expect(page).toContain('Duplicate source linked');
    expect(page).toContain('Sample rows, first 5 only');
    expect(page).toContain('sample_rows');
    expect(page).toContain('Malformed rows');
    expect(page).toContain('Unresolved values');
    expect(page).toContain('activeImportPreview.unresolved_count');
    expect(page).toContain('Human mapping review');
    expect(page).toContain("supabase.from('file_import_mapping_reviews')");
    expect(page).toContain("supabase.rpc('review_file_import_mapping'");
    expect(page).toContain('No canonical records are changed here');
  });

  it('is registered as a first-class admin page', () => {
    expect(shell).toContain("const FileSystemPage = React.lazy(() => import('../pages/FileSystemPage'));");
    expect(shell).toContain("{ id: 'files', label: 'File System', icon: FolderOpen }");
    expect(shell).toContain("case 'files':");
  });
});