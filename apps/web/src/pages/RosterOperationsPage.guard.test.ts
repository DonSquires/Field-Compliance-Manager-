import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
const page = readFileSync(resolve(process.cwd(), 'src/pages/RosterOperationsPage.tsx'), 'utf8');
const shell = readFileSync(resolve(process.cwd(), 'src/shells/AdminShell.tsx'), 'utf8');
describe('enterprise roster operations', () => {
  it('combines canonical field shifts and typed workforce slots', () => {
    expect(page).toContain("from('shifts')");
    expect(page).toContain("from('roster_slots')");
    expect(page).toContain("from('roster_assignments')");
    expect(page).toContain('officer:user_profiles!roster_assignments_officer_id_fkey(display_name)');
    expect(page).toContain('Array.isArray(assignment.officer)');
    expect(page).toContain('sourceOfficerName(assignment)');
    expect(page).toContain('sourceBoardAssignments');
    expect(page).toContain('assignment.patrol_route_id === unit.patrol_route_id');
    expect(page).not.toContain('roster-history-table-wrap');
    expect(page).toContain('!slot.linked_shift_id');
    expect(shell).toContain('return <RosterOperationsPage />');
  });
  it('combines authorized branch staff, leave, availability, and coverage demand', () => {
    expect(page).toContain("supabase.rpc('get_operating_branch_roster_staff'");
    expect(page).toContain('operatingOrganizationId ?? profile?.organizationId');
    expect(page).toContain('p_organization_id: operatingBranchId');
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
    expect(page).toContain("supabase.rpc('create_roster_slot_with_break'");
    expect(page).toContain('p_planned_break_minutes: Number(form.breakMinutes)');
    expect(page).toContain('p_break_unpaid: form.breakUnpaid');
    expect(page).toContain('Open shift — advertise to available staff');
    expect(page).toContain('required={Boolean(editingSlot)}');
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

  it('clears loading state when organization scope is unavailable', () => {
    expect(page).toContain('if (!org) {');
    expect(page).toContain('setLoading(false);');
  });

  it('keeps Deputy import out of the live roster and blocks shifts without a work unit', () => {
    expect(page).not.toContain('DeputyImportWizard');
    expect(page).not.toContain('Import from Deputy');
    expect(page).toContain('workUnits.length > 0 && <>');
    expect(page).toContain("(loading || workUnits.length > 0) && <>");
    expect(page).toContain("Add rosterable staff in People as well.");
  });

  it('uses role-specific planning language without changing the roster job', () => {
    expect(page).toContain("grand_master: { eyebrow: 'Roster oversight'");
    expect(page).toContain("admin: { eyebrow: 'Team planning'");
    expect(page).toContain("admin_officer: { eyebrow: 'Daily scheduling'");
    expect(page).toContain('<h1>Roster</h1><p>{rosterView.description}</p>');
  });

  it('supports staff and work-unit planning with direct timesheet handoff', () => {
    expect(page).toContain('Staff schedule');
    expect(page).toContain('Work unit schedule');
    expect(page).toContain("openCreate(undefined, day, unit.id)");
    expect(page).toContain("if (!workUnitOverride && selectedSlot?.status === 'draft')");
    expect(page).toContain('setEditingSlot(null)');
    expect(page).toContain("scheduleMode === 'staff' && staff.length === 0");
    expect(page).toContain("scheduleMode === 'staff' && <div className=\"roster-readiness\"");
    expect(page).toContain("scheduleMode === 'staff' ? 'Staff' : 'Work unit'");
    expect(page).toContain("navigate('/admin/people-hr?tab=timesheets')");
  });
  it('locks the workbench to its parent and selects officers without creating a shift', () => {
    expect(page).toContain('roster-workbench-panes');
    expect(page).toContain('aria-label="Officer directory"');
    expect(page).toContain('const scheduleStaff = visibleStaff.filter');
    expect(page).toContain('aria-label="Roster branch"');
    expect(page).toContain('setOperatingOrganization(event.target.value)');
    expect(page).toContain('roster-command-workbench');
    expect(page).toContain("loading || !rosterDataReady ? '—' : openSlots.length");
  });
  it('uses unknown credential and timesheet read states instead of inventing licences or zero approvals', () => {
    expect(page).toContain("user.credential_verified === null || user.credential_verified === undefined ? 'unknown'");
    expect(page).toContain('Credentials not recorded');
    expect(page).toContain('Recorded credentials verified');
    expect(page).not.toContain("return 'licence clear'");
    expect(page).toContain("<RosterTimesheetPanel");
    expect(page).toContain("timesheetCount ?? '—'");
  });
});
