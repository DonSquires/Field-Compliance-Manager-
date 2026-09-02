import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const zoneSource = readFileSync(resolve(process.cwd(), 'src/pages/ZoneDetailPage.tsx'), 'utf8');

describe('ZoneDetailPage compliance limit authoring', () => {
  it('lets an admin edit nightly limits and SCV requirement through the governed zone command', () => {
    expect(zoneSource).toContain("rpc('manage_crm_zone'");
    expect(zoneSource).toContain('p_expected_version: selected.configuration_version');
    expect(zoneSource).toContain('p_nightly_limit_consecutive: nightlyLimitConsecutive');
    expect(zoneSource).toContain('p_nightly_limit_monthly: nightlyLimitMonthly');
    expect(zoneSource).toContain('p_scv_required: complianceForm.scv_required');
    expect(zoneSource).not.toContain("from('location_zones')");
  });

  it('treats an empty limit field as no limit rather than zero', () => {
    expect(zoneSource).toContain("complianceForm.nightly_limit_consecutive.trim() ? Number(complianceForm.nightly_limit_consecutive) : null");
    expect(zoneSource).toContain("complianceForm.nightly_limit_monthly.trim() ? Number(complianceForm.nightly_limit_monthly) : null");
  });
});
