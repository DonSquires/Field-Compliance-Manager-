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
    expect(page).toContain('Every stop on the run keeps its own client and contract, so billing follows the place, not the shift.');
    expect(page).toContain('Office and internal work belongs to your organisation. It is never billed to a client.');
  });
  it('stores the contracted places it loads so static posts can actually be created', () => {
    expect(page).toContain('setLocations((c.data as AgreementLocation[]) ?? [])');
    expect(page).toContain('No contracted places to pick from yet.');
    expect(page).toContain('This agreement does not include static guarding.');
    expect(page).toContain("moduleId: nextModules.length === 1 ? nextModules[0].id : ''");
  });
  it('tells the rosterer where each kind of work unit comes from and offers the next step', () => {
    expect(page).toContain('No patrol runs to pick from yet.');
    expect(page).toContain('No workplaces yet.');
    expect(page).toContain('Roster it');
    expect(page).toContain('workUnitId: unit.id');
    expect(page).toContain('SERVICE_TYPE_SUGGESTIONS');
  });
  it('focuses the requested work unit and preserves it for assignment', () => {
    expect(page.includes('readWorkflowContext(location.search)')).toBe(true);
    expect(page.includes('`work-unit-${requestedUnit.id}`')).toBe(true);
    expect(page.includes("' is-focused'")).toBe(true);
    expect(page.includes('Create assignment')).toBe(true);
    expect(page.includes('workflowContextQuery({ ...workflowContext, workUnitId: unit.id })')).toBe(true);
  });
  it('scopes contract locations and modules when opened from an agreement', () => {
    expect(page).toContain('workflowContext.agreementId');
    expect(page).toContain('const scopedLocations');
    expect(page).toContain('const scopedModules');
  });
});
