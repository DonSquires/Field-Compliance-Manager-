/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(resolve(import.meta.dirname, '../../../../supabase/migrations/20260831082000_govern_crm_agreement_setup.sql'), 'utf8');
const zoneCoverageSql = readFileSync(resolve(import.meta.dirname, '../../../../supabase/migrations/20260905006800_govern_crm_agreement_zone_coverage.sql'), 'utf8');

describe('governed CRM agreement setup', () => {
  it('loads only provider-admin agreement setup evidence', () => {
    expect(sql).toContain('get_crm_agreement_setup');
    expect(sql).toContain('is_admin_for_org(v_agreement.provider_organization_id)');
    expect(sql).toContain("'sites'");
    expect(sql).toContain("'modules'");
  });

  it('configures only accepted operational agreements with expected state', () => {
    expect(sql).toContain("v_agreement.agreement_type<>'operational'");
    expect(sql).toContain("v_agreement.invitation_status<>'accepted'");
    expect(sql).toContain('v_agreement.invitation_status is distinct from p_expected_invitation_status');
  });

  it('links only active client sites and validates canonical modules', () => {
    expect(sql).toContain('s.client_organization_id=v_agreement.client_organization_id and s.active');
    expect(sql).toContain('module_catalog mc where mc.module_key=p_module_key and mc.active');
    expect(sql).toContain('on conflict(service_agreement_id,site_id)');
    expect(sql).toContain('on conflict(service_agreement_id,module_key)');
  });

  it('synchronizes module summaries, audits changes, and closes direct browser writes', () => {
    expect(sql).toContain('set enabled_modules=coalesce');
    expect(sql).toContain("'crm_agreement_'||p_action");
    expect(sql).toContain('revoke insert,update,delete,truncate on public.service_agreement_locations');
    expect(sql).toContain('revoke insert,update,delete,truncate on public.service_agreement_modules');
  });

  it('governs explicit active client Zone coverage alongside Site coverage', () => {
    expect(zoneCoverageSql).toContain("'zones'");
    expect(zoneCoverageSql).toContain('sal.zone_id=z.id');
    expect(zoneCoverageSql).toContain('manage_crm_agreement_zone_coverage');
    expect(zoneCoverageSql).toContain("p_action NOT IN ('link_zone','unlink_zone')");
    expect(zoneCoverageSql).toContain('z.organization_id=v_agreement.client_organization_id AND z.is_active');
  });
});