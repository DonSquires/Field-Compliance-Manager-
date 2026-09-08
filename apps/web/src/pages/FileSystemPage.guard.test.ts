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

  it('is registered as a first-class admin page', () => {
    expect(shell).toContain("const FileSystemPage = React.lazy(() => import('../pages/FileSystemPage'));");
    expect(shell).toContain("{ id: 'files', label: 'File System', icon: FolderOpen }");
    expect(shell).toContain("case 'files':");
  });
});