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
    expect(page).toContain('Payroll role: {rule.role_code}');
  });
});