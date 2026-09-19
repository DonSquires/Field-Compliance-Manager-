import { describe, expect, it } from 'vitest';
import { deputyDateTimeToIso, locationGuidance, mapLeaveType, parseCsv, parseDeputyExport, proposeLocationType, splitDisplayName, stableUuid } from './deputyImport';

// Header order of the real Deputy "Timesheets + Schedules" export (94 columns).
const HEADER = ['Payroll ID', 'Display Name', 'Timesheet Date', 'Timesheet Start Time', 'Timesheet End Time', 'Timesheet Unpaid Break (Total)', 'Timesheet Total Time', 'Timesheet Cost', 'Timesheet Rest or Meal Break (Total)', 'Timesheet Unpaid Break (Scheduled)', 'Timesheet Unpaid Break (Duration Only)', 'Timesheet Rest or Meal Break (Scheduled)', 'Timesheet Rest or Meal Break (Duration Only)', 'Employee Comment', 'Time Approved', 'Is In Progress', 'Discarded', 'Is Leave', 'Pay Approved', 'Exported', 'Paid', 'Real Time', 'Auto Rounded', 'Auto Time Approved', 'Validation Flag', 'Timesheet Created', 'Timesheet Modified', 'First Name', 'Last Name', 'Date Of Birth', 'Gender', 'Employed', 'Start Date', 'Termination Date', 'Position', 'Employee Modified', 'Pay Center', 'Employee Export Code', 'Schedule Date', 'Schedule Start Time', 'Schedule End Time', 'Schedule Unpaid Break (Total)', 'Schedule Rest or Meal Break (Total)', 'Schedule Unpaid Break (Scheduled)', 'Schedule Rest or Meal Break (Scheduled)', 'Schedule Unpaid Break (Duration Only)', 'Schedule Rest or Meal Break (Duration Only)', 'Schedule Total Time', 'Schedule Cost', 'Schedule Warning', 'Schedule Notes', 'Schedule Published', 'Schedule Open', 'Schedule Created', 'Schedule Modified', 'Area Created', 'Area Modified', 'Area Name', 'Area Export Code', 'Location Code', 'Location Name', 'Roster Sort Order', 'Show On Roster', 'Time Start', 'Time End', 'Date Start', 'Date End', 'Days', 'Leave Comment', 'Leave Status', 'Leave Manager Comment', 'Total Hours', 'Leave Type Name', 'Leave Export Code', 'Paid Leave', 'Access Level Name', 'Stress Profile Name', 'Email', 'Phone', 'Code', 'Location Name', 'Active', 'Is Workplace', 'Is Pay Center', 'Company Created', 'Company Modified', 'Pay Period Name', 'Pay Period Active', 'Pay Period Start Date', 'Pay Period Cycle', 'REQ / RITM Number', 'Purchase Order', 'EMS Minutes', 'NCR Minutes'];

function row(overrides: Record<string, string>): string {
  const cells = HEADER.map(() => '');
  const set = (name: string, value: string, occurrence = 0) => { let seen = -1; HEADER.forEach((h, i) => { if (h === name) { seen += 1; if (seen === occurrence) cells[i] = value; } }); };
  for (const [key, value] of Object.entries(overrides)) set(key, value);
  return cells.map((c) => (/[",\n]/.test(c) ? `"${c.replaceAll('"', '""')}"` : c)).join(',');
}

const csv = [
  HEADER.join(','),
  row({ 'Display Name': '(N)PTL - Test Officer One [900001]', 'Employee Export Code': '900001', 'Timesheet Date': '14/05/2026', 'Timesheet Start Time': '18:00', 'Timesheet End Time': '2:00', 'Is Leave': 'FALSE', 'Schedule Date': '14/05/2026', 'Schedule Start Time': '18:00', 'Schedule End Time': '2:00', 'Schedule Published': 'TRUE', 'Schedule Notes': 'Night run. SRBA required.', 'Schedule Warning': 'Stressed : Minimum 10 hours between shifts', 'Area Name': 'Patrols', 'Area Export Code': '356310000|MPP', 'Location Code': '6947', 'Location Name': 'NSN: 585 Day Patrol', 'REQ / RITM Number': 'na', 'Purchase Order': 'na', 'EMS Minutes': '0', 'NCR Minutes': '' }),
  row({ 'Display Name': '(N)CAS - Test Officer Two [900002]', 'Employee Export Code': '900002', 'Timesheet Date': '14/05/2026', 'Timesheet Start Time': '9:00', 'Timesheet End Time': '17:00', 'Is Leave': 'FALSE', 'Schedule Date': '14/05/2026', 'Schedule Start Time': '9:00', 'Schedule End Time': '17:00', 'Schedule Published': 'TRUE', 'Schedule Notes': '1 x static guard for general court duties. SRBA Required', 'Area Name': 'Ordinary Time', 'Area Export Code': '350369979|SGC1', 'Location Code': '839', 'Location Name': 'NSN: MOJ Nelson District Court', 'REQ / RITM Number': 'RITM0237298', 'Purchase Order': 'Nelson DC - 14/05/2026', 'EMS Minutes': '', 'NCR Minutes': '' }),
  row({ 'Display Name': '(N)CAS - Test Officer Two [900002]', 'Employee Export Code': '900002', 'Timesheet Date': '15/05/2026', 'Timesheet Start Time': '9:00', 'Timesheet End Time': '17:00', 'Is Leave': 'FALSE', 'Area Name': 'Call Centre Ord Time', 'Area Export Code': '300873001|NSC', 'Location Code': '2573', 'Location Name': 'NSC: After Hours Rosterer', 'EMS Minutes': '480' }),
  row({ 'Display Name': '(N)PTL - Test Officer One [900001]', 'Employee Export Code': '900001', 'Timesheet Date': '7/04/2026', 'Is Leave': 'TRUE', 'Date Start': '7/04/2026', 'Date End': '10/06/2026', 'Total Hours': '384', 'Leave Type Name': 'LWOP WK2+', 'Leave Status': 'Approved' }),
  row({ 'Display Name': '(N)CAS - Test Officer Two [900002]', 'Employee Export Code': '900002', 'Timesheet Date': '14/05/2026', 'Is Leave': 'TRUE', 'Date Start': '14/05/2026', 'Date End': '14/05/2026', 'Total Hours': '8', 'Leave Type Name': 'Offered', 'Leave Status': 'Approved' }),
].join('\n');

describe('Deputy export parsing', () => {
  it('reads quoted fields with commas, doubled quotes and embedded newlines', () => {
    expect(parseCsv('a,"b, c","say ""hi""","line1\nline2"\n')).toEqual([['a', 'b, c', 'say "hi"', 'line1\nline2']]);
  });

  it('converts Deputy d/m/yyyy + h:mm to NZ local ISO timestamps', () => {
    expect(deputyDateTimeToIso('14/05/2026', '9:00')).toBe('2026-05-14T09:00:00+12:00');
    expect(deputyDateTimeToIso('2026-05-14', '9:00')).toBeNull();
  });

  it('separates the person name from the branch/category prefix and export code', () => {
    expect(splitDisplayName('(N)CAS - Dean Example [521735]')).toEqual({ cleanName: 'Dean Example', exportCode: '521735' });
  });

  it('proposes what each Deputy location can become here', () => {
    expect(proposeLocationType('NSN: 585 Day Patrol', ['MPP']).type).toBe('patrol');
    expect(proposeLocationType('NSN: MOJ Nelson District Court', ['SGC1']).type).toBe('static');
    expect(proposeLocationType('NSC: After Hours Rosterer', ['NSC'])).toEqual({ type: 'internal', serviceType: 'call_centre' });
    expect(proposeLocationType('NSN: EMS Blenheim', ['EMS']).type).toBe('on_call');
    expect(locationGuidance('patrol').canCreate).toBe(false);
    expect(locationGuidance('internal').canCreate).toBe(true);
  });

  it('maps Deputy leave names onto our leave types and skips offered-shift pseudo leave', () => {
    expect(mapLeaveType('LWOP WK2+')).toBe('unpaid');
    expect(mapLeaveType("Sick (Personal/Carer's) Leave")).toBe('sick');
    expect(mapLeaveType('Annual Leave (Vacation)')).toBe('annual');
    expect(mapLeaveType('ALT HOLIDAY TAKEN (LIEU)')).toBe('annual');
    expect(mapLeaveType('ACC NWK WEEK2+')).toBe('other');
    expect(mapLeaveType('Offered')).toBe('skip');
  });

  it('keeps the same key for the same schedule so re-imports never duplicate', async () => {
    const a = await stableUuid('schedule|900001|2026-05-14T18:00:00+12:00|6947');
    const b = await stableUuid('schedule|900001|2026-05-14T18:00:00+12:00|6947');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('separates people, locations, schedules, timesheets and leave, keeping billing evidence on the slot', async () => {
    const result = await parseDeputyExport(csv);
    expect(result.rows).toBe(5);
    expect(result.people.map((p) => p.exportCode)).toEqual(['900001', '900002']);
    expect(result.locations.map((l) => l.name)).toEqual(['NSN: 585 Day Patrol', 'NSN: MOJ Nelson District Court', 'NSC: After Hours Rosterer']);
    expect(result.locations[0]).toMatchObject({ code: '6947', proposedType: 'patrol', payCodes: ['MPP'], scheduleRows: 1 });
    expect(result.slots).toHaveLength(2);
    expect(result.slots[0]).toMatchObject({ exportCode: '900001', deputyCode: '6947', startsAt: '2026-05-14T18:00:00+12:00', endsAt: '2026-05-14T14:00:00.000Z', payCode: 'MPP', emsMinutes: 0, purchaseOrder: null, reqRitm: null, warning: 'Stressed : Minimum 10 hours between shifts', published: true });
    expect(result.slots[1]).toMatchObject({ deputyCode: '839', purchaseOrder: 'Nelson DC - 14/05/2026', reqRitm: 'RITM0237298', notes: '1 x static guard for general court duties. SRBA Required' });
    expect(result.timesheetRows).toBe(3);
    expect(result.leave).toHaveLength(2);
    expect(result.leave[0]).toMatchObject({ exportCode: '900001', startsOn: '2026-04-07', endsOn: '2026-06-10', leaveType: 'unpaid', hours: '384', status: 'Approved' });
    expect(result.leave[1].leaveType).toBe('skip');
    expect(result.warnings).toEqual([]);
  });

  it('refuses a file that is not a Deputy export', async () => {
    await expect(parseDeputyExport('name,date\nx,y\n')).rejects.toThrow(/does not look like a Deputy timesheet\/schedule export/);
  });
});
