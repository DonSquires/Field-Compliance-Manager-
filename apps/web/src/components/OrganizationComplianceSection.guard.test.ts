import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src/components/OrganizationComplianceSection.tsx'), 'utf8');

describe('organization compliance governance', () => {
  it('uses governed RPCs for all company identity and compliance writes', () => {
    expect(source).toContain("supabase.rpc('update_organization_corporate_profile'");
    expect(source).toContain("supabase.rpc('review_organization_corporate_profile'");
    expect(source).toContain("supabase.rpc('save_organization_compliance_record'");
    expect(source).toContain("supabase.rpc('review_organization_compliance_record'");
    expect(source).not.toMatch(/\.from\(['"]organizations['"]\)[\s\S]{0,200}\.(update|insert|delete)\(/);
    expect(source).not.toMatch(/\.from\(['"]organization_compliance_records['"]\)[\s\S]{0,200}\.(update|insert|delete)\(/);
  });

  it('shows source, verification, expiry, and human next actions', () => {
    expect(source).toContain('Source file or register');
    expect(source).toContain('source_as_of');
    expect(source).toContain('verification_status');
    expect(source).toContain('expiryState');
    expect(source).toContain('Verify identity');
    expect(source).toContain('Verify</button>');
    expect(source).toContain('<option value="registered">Registered</option>');
    expect(source).toContain('<option value="company">Company</option>');
  });

  it('preserves replacement history instead of deleting records', () => {
    expect(source).toContain('Replaces an older record');
    expect(source).toContain('p_replaces_record_id');
    expect(source).not.toMatch(/\.delete\(/);
  });
});
