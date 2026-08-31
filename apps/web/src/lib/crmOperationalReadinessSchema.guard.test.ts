/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260831083000_crm_operational_readiness.sql'), 'utf8');

describe('CRM operational readiness', () => {
  it('authorizes provider administrators against an operational agreement', () => {
    expect(sql).toContain('is_admin_for_org(v_agreement.provider_organization_id)');
    expect(sql).toContain("v_agreement.agreement_type<>'operational'");
  });

  it('uses canonical coverage, boundary, module, billing, work-unit, and reporting evidence', () => {
    for (const entity of ['service_agreement_locations', 'client_sites', 'geofence_boundary_history', 'service_agreement_modules', 'crm_commercial_settings', 'site_financial_config', 'roster_work_units', 'report_templates']) expect(sql).toContain(entity);
    expect(sql).toContain("s.boundary_status<>'authoritative'");
    expect(sql).toContain("s.boundary_verification<>'verified'");
    expect(sql).toContain('coalesce(c.base_rate_per_hour,c.callout_rate_per_hour,c.travel_rate_per_km)>0');
  });

  it('returns human blockers with owners and existing UI destinations', () => {
    for (const destination of ["'relationships'", "'sites'", "'crm'", "'roster-targets'", "'reports'"]) expect(sql).toContain(destination);
    for (const key of ['coverage', 'boundary', 'modules', 'billing', 'operations', 'reporting']) expect(sql).toContain(`'key','${key}'`);
    expect(sql).not.toContain('percentage');
  });

  it('exposes read-only readiness through an authenticated RPC', () => {
    expect(sql).toContain('revoke all on function public.get_crm_operational_readiness(uuid)');
    expect(sql).toContain('grant execute on function public.get_crm_operational_readiness(uuid) to authenticated,service_role');
  });
});