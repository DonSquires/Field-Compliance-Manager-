import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260905006400_branch_provider_crm_account_access.sql'), 'utf8');

describe('branch provider CRM account access', () => {
  it('requires an accepted operational agreement from an administered provider branch', () => {
    expect(migration).toContain('get_descendant_organizations');
    expect(migration).toContain("agreement.agreement_type='operational'");
    expect(migration).toContain("agreement.invitation_status='accepted'");
    expect(migration).toContain('is_admin_for_org(agreement.provider_organization_id)');
  });
});