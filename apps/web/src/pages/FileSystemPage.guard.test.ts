import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const page = readFileSync(resolve(process.cwd(), 'src/pages/FileSystemPage.tsx'), 'utf8');
const shell = readFileSync(resolve(process.cwd(), 'src/shells/AdminShell.tsx'), 'utf8');

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
    expect(page).toContain('openGeneratedOutput');
  });

  it('surfaces enforcement notices separately from Bob-generated outputs', () => {
    expect(page).toContain("from('notices_to_vacate')");
    expect(page).toContain("from('infringement_notices')");
    expect(page).toContain("from('notice-artifacts')");
    expect(page).toContain('Enforcement notice artifacts');
    expect(page).toContain('openNoticeArtifact');
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

  it('quarantines unsafe, partial, and unknown intake artifacts before registration', () => {
    expect(page).toContain('Unsupported or unsafe artifact');
    expect(page).toContain('Office lock file');
    expect(page).toContain('Quarantined:');
  });

  it('shows a manifest-based import preview for staged sample data before promotion', () => {
    expect(page).toContain('Import preview');
    expect(page).toContain('Batch manifest');
    expect(page).toContain('structured_data');
    expect(page).toContain('quarantine');
    expect(page).toContain('Column mapping');
    expect(page).toContain('duplicate rows');
    expect(page).toContain('unresolved references');
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
  });

  it('is registered as a first-class admin page', () => {
    expect(shell).toContain("const FileSystemPage = React.lazy(() => import('../pages/FileSystemPage'));");
    expect(shell).toContain("{ id: 'files', label: 'File System', icon: FolderOpen }");
    expect(shell).toContain("case 'files':");
  });
});