import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
const page = readFileSync(resolve(process.cwd(), 'src/pages/RosterOperationsPage.tsx'), 'utf8');
const shell = readFileSync(resolve(process.cwd(), 'src/shells/AdminShell.tsx'), 'utf8');
describe('enterprise roster operations', () => {
  it('combines canonical field shifts and typed workforce slots', () => {
    expect(page).toContain("from('shifts')");
    expect(page).toContain("from('roster_slots')");
    expect(page).toContain('!slot.linked_shift_id');
    expect(shell).toContain('return <RosterOperationsPage />');
  });
  it('combines authorized branch staff, leave, availability, and coverage demand', () => {
    expect(page).toContain("supabase.rpc('get_operating_branch_roster_staff'");
    expect(page).toContain('operatingOrganizationId ?? profile?.organizationId');
    for (const table of ['leave_requests', 'staff_availability', 'shift_coverage_requests', 'roster_work_units']) expect(page).toContain(`from('${table}')`);
    expect(page).toContain('hasAvailabilityConflict');
    expect(page).toContain('Availability restrictions');
  });
  it('offers week, fortnight, and month horizons with governed NZ holidays', () => {
    expect(page).toContain("['fortnight', '2 weeks']");
    expect(page).toContain("['month', 'Month']");
    expect(page).toContain('nzRosterHolidays');
    expect(page).toContain("from('organization_calendar_settings')");
    expect(page).toContain("supabase.rpc('set_organization_calendar_region'");
  });
  it('surfaces status-only wage, billing, quote, geofence, and cost-centre readiness', () => {
    expect(page).toContain("supabase.rpc('get_roster_commercial_readiness'");
    for (const label of ['Wage rule', 'Billing', 'Quote', 'Geofence', 'Cost centre']) expect(page).toContain(label);
    expect(page).toContain('Commercial readiness exceptions');
  });
  it('creates slots and materializes only field work through governed RPCs', () => {
    expect(page).toContain("supabase.rpc('create_roster_slot'");
    expect(page).toContain("supabase.rpc('materialize_roster_slot'");
    expect(page).toContain("unit?.work_unit_type !== 'internal'");
    expect(page).not.toContain(".from('shifts').insert");
  });
  it('manages typed slot lifecycle only through governed admin RPCs', () => {
    expect(page).toContain("supabase.rpc('manage_roster_slot'");
    expect(page).toContain("supabase.rpc('reassign_roster_slot'");
    expect(page).toContain('Reassignment reason');
    expect(page).toContain('Replacement officer');
    expect(page).not.toContain(".from('roster_slots').update");
  });
  it('polls shared slot and shift ownership without putting the roster back into loading state', () => {
    expect(page).toContain('syncOfficerResponses');
    expect(page).toContain("supabase.from('roster_slots')");
    expect(page).toContain("supabase.from('shifts')");
    expect(page).toContain('window.setInterval(() => void syncOfficerResponses(), 15_000)');
  });
  it('turns work-unit context into an explicit preselected roster action', () => {
    expect(page.includes('readWorkflowContext(location.search)')).toBe(true);
    expect(page.includes('unit.id === workflowContext.workUnitId')).toBe(true);
    expect(page.includes('workUnitId: requestedWorkUnit?.id ??')).toBe(true);
    expect(page.includes('Create shift for this work unit')).toBe(true);
    expect(page.includes('workflowContextQuery(workflowContext)')).toBe(true);
  });
  it('keeps mobilisation handoff ownership visible and directly reachable', () => {
    expect(page).toContain('Mobilisation handoff · roster evidence');
    expect(page).toContain('Return to handoff');
    expect(page).toContain('`/admin/handoffs${workflowContextQuery(workflowContext)}`');
  });
});
