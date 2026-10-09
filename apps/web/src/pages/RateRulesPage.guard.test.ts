import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const page = readFileSync(resolve(process.cwd(), 'src/pages/RateRulesPage.tsx'), 'utf8');

describe('operating branch rate rules page', () => {
  it('uses the selected operating branch for rate reads and governed mutations', () => {
    expect(page).toContain('operatingOrganizationId ?? profile?.organizationId');
    expect(page).toContain("supabase.rpc('manage_operating_branch_rate_rule'");
    expect(page).toContain('p_operating_organization_id: operatingOrganizationId ?? profile?.organizationId');
    expect(page).toContain('Rate rule updated with a new audit revision.');
    expect(page).toContain(".from('reference_codes').select('code,name')");
    expect(page).toContain('p_role_code: form.kind === \'pay\' ? form.roleCode');
    expect(page).toContain('`Payroll role ${rule.role_code}`');
  });

  it('saves client, place, and effective-date scopes supported by the rate resolver', () => {
    expect(page).toContain('from(\'service_agreement_locations\')');
    expect(page).toContain('aria-label="Customer billing scope"');
    expect(page).toContain('Client account');
    expect(page).toContain('Site or zone override');
    expect(page).toContain('Effective from');
    expect(page).toContain('Effective through');
    expect(page).toContain('p_client_org_id: form.kind === \'billing\' ? form.clientOrgId || null : null');
    expect(page).toContain('p_site_id: form.kind === \'billing\' ? form.siteId || null : null');
    expect(page).toContain('p_zone_id: form.kind === \'billing\' ? form.zoneId || null : null');
    expect(page).toContain('p_effective_from: form.effectiveFrom || null');
    expect(page).toContain('p_effective_to: form.effectiveTo || null');
  });

  it('manages patrol-only SLA bands and rechecks completed visits without silently pricing them at zero', () => {
    expect(page).toContain(".eq('module_key', 'patrol')");
    expect(page).toContain("supabase.rpc('manage_patrol_sla_discount_band'");
    expect(page).toContain('discount / 100');
    expect(page).toContain("supabase.rpc('resolve_patrol_stop_charge_line'");
    expect(page).toContain('No amount was charged.');
    expect(page).toContain('No active service agreement is linked to this patrol shift.');
    expect(page).toContain('Completed patrol visits awaiting a per-visit rate');
  });

  it('uses one branch-scoped editable register with local search and filters', () => {
    expect(page).toContain('const visibleRules = useMemo(() => rules.filter');
    expect(page).toContain('aria-label="Pay and charge rule register"');
    expect(page).toContain('aria-label="Search pay and charge rules"');
    expect(page).toContain('Filter by rule type');
    expect(page).toContain('Filter by rule status');
    expect(page).toContain('No rules match these filters.');
    expect(page).not.toContain('className="contacts-list">{rules.map');
  });
});