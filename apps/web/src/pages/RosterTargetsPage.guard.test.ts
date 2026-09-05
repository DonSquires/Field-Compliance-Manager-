import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
const page = readFileSync(resolve(import.meta.dirname, 'RosterTargetsPage.tsx'), 'utf8');
const shell = readFileSync(resolve(import.meta.dirname, '../shells/AdminShell.tsx'), 'utf8');
describe('roster target catalog', () => {
  it('is a first-class admin route', () => {
    expect(shell).toContain("'roster-targets'");
    expect(shell).toContain('return <RosterTargetsPage />');
  });
  it('loads all typed target and supporting reference sources', () => {
    for (const table of ['roster_work_units', 'patrol_routes', 'service_agreement_locations', 'service_agreement_modules', 'organization_workplaces', 'teams', 'cost_centres']) expect(page).toContain(`from('${table}')`);
  });
  it('uses governed RPCs and explains attribution by type', () => {
    expect(page).toContain("supabase.rpc('create_operating_roster_work_unit'");
    expect(page).toContain("'create_operating_organization_workplace'");
    expect(page).toContain("'create_operating_cost_centre'");
    expect(page).toContain('p_operating_organization_id: activeOperatingOrganizationId');
    expect(page).toContain('Client and contract attribution remains at each generated stop-module attendance.');
    expect(page).toContain('Internal work is provider-owned and never linked to a client agreement.');
  });
  it('focuses the requested work unit and preserves it for assignment', () => {
    expect(page.includes('readWorkflowContext(location.search)')).toBe(true);
    expect(page.includes('`work-unit-${requestedUnit.id}`')).toBe(true);
    expect(page.includes("' is-focused'")).toBe(true);
    expect(page.includes('Create assignment')).toBe(true);
    expect(page.includes('workflowContextQuery(workflowContext)')).toBe(true);
  });
  it('scopes contract locations and modules when opened from an agreement', () => {
    expect(page).toContain('workflowContext.agreementId');
    expect(page).toContain('const scopedLocations');
    expect(page).toContain('const scopedModules');
  });
});
