import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260830144000_govern_crm_organization_spine.sql'), 'utf8');

describe('governed CRM organization spine', () => {
  it('searches before create without exposing unmanaged private organizations', () => {
    expect(sql).toContain('find_crm_organization_candidates');
    expect(sql).toContain('or o.discoverable');
    expect(sql).toContain('Enter at least two name characters or an NZBN');
  });

  it('creates retry-safe inactive prospects and prevents hierarchy duplicates', () => {
    expect(sql).toContain('idx_organizations_parent_client_request');
    expect(sql).toContain("false,'prospect'");
    expect(sql).toContain('An organization with this name already exists in your account hierarchy');
  });

  it('race-checks edits and refuses direct activation', () => {
    expect(sql).toContain('v_org.updated_at<>p_expected_updated_at');
    expect(sql).toContain('v_org.parent_organization_id is distinct from v_provider');
    expect(sql).toContain('CRM cannot directly activate an organization');
    expect(sql).toContain("'crm_organization_'||p_action");
  });

  it('derives human blockers from real contact, site, agreement, module, billing, and work-unit evidence', () => {
    for (const entity of ['crm_contacts', 'client_sites', 'service_agreements', 'crm_commercial_settings', 'roster_work_units']) expect(sql).toContain(entity);
    expect(sql).toContain('Ready for activation review');
  });

  it('closes all direct browser organization mutations', () => {
    expect(sql).toContain('revoke insert,update,delete,truncate on public.organizations from public,anon,authenticated');
    expect(sql).toContain('update_organization_profile');
    expect(sql).toContain("'organization_profile_updated'");
  });
});