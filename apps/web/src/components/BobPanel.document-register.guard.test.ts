import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src/components/BobPanel.tsx'), 'utf8');

describe('Bob governed document intake', () => {
  it('registers non-video attachments through the admin-scoped document function', () => {
    expect(source).toContain("supabase.functions.invoke('bob-document-register'");
    expect(source).toContain('attachment_id: attachmentId');
    expect(source).toContain("const DOCUMENT_REGISTRATION_ROLES = new Set(['grand_master', 'master', 'admin', 'admin_officer'])");
    expect(source).toContain('DOCUMENT_REGISTRATION_ROLES.has(profile.role)');
    expect(source).toContain("register-bob-video-attachment");
  });
});