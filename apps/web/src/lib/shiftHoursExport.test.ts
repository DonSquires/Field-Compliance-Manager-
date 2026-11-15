import { describe, expect, it } from 'vitest';
import { buildShiftHoursExport, parseShiftHoursRows, shiftHoursVersion, type ShiftHoursReviewRow } from './shiftHoursExport';

const row = (changes: Partial<ShiftHoursReviewRow> = {}): ShiftHoursReviewRow => ({
  id: 'shift-1', organization_id: 'employer', staff_id: 'staff-1', staff_name: 'Fixture staff',
  officer_user_id: 'officer', service_type: 'guard', status: 'completed', updated_at: '2020-06-01T06:00:00Z',
  scheduled_start: '2020-05-31T21:00:00Z', scheduled_end: '2020-06-01T05:30:00Z',
  actual_start: '2020-05-31T21:02:00Z', actual_end: '2020-06-01T05:31:00Z',
  payable_start: '2020-05-31T21:00:00Z', payable_end: '2020-06-01T05:30:00Z',
  unpaid_minutes: 30, recorded_unpaid_minutes: 29, planned_unpaid_minutes: 30,
  correction_updated_at: null, correction_reason: 'PRIVATE correction', review_reason: 'PRIVATE review',
  hours_status: 'confirmed', start_mismatch: false, finish_mismatch: false, unpaid_break_mismatch: false,
  source_revision: 'a'.repeat(32), review_revision: 1, review_status: 'approved',
  can_edit_hours: true, can_review_hours: true, client_organization_id: 'client',
  client_name: 'Agreement client', service_agreement_id: 'agreement', location_name: 'Fixture workplace',
  client_link_problem: null, payroll_adjustment_pending: false, employee_number: 'EMP-12',
  pay_rate: 31.27, charge_rate: 53.46, ...changes,
});

describe('shift hours handoff', () => {
  it('exports approved shift detail, NZ timestamps, breaks, staff subtotals and a grand total without double-counting detail hours', () => {
    const result = buildShiftHoursExport([row(), row({ id: 'shift-2' })], 'payroll', null);
    expect(result.lines).toHaveLength(2);
    expect(result.lines[0]).toMatchObject({ staff_name: 'Fixture staff', location: 'Fixture workplace',
      employee_number: 'EMP-12', start: '2020-06-01 09:00:00 +12:00', finish: '2020-06-01 17:30:00 +12:00',
      unpaid_minutes: 30, hours: 8, recorded_start: '2020-06-01 09:02:00 +12:00' });
    expect(result.groups).toEqual([{ name: 'Fixture staff', hours: 16 }]);
    expect(result.totalHours).toBe(16);
    expect(result.csv).toContain('Staff total');
    expect(result.csv).toContain('Grand total');
    expect(result.csv).not.toContain('PRIVATE');
    expect(result.csv).not.toContain('31.27');
  });

  it('requires an actual client selection and allowlists client evidence, not employee/pay/internal fields', () => {
    expect(() => buildShiftHoursExport([row()], 'client', null)).toThrow(/choose.*client/i);
    const result = buildShiftHoursExport([row(), row({ id: 'other', client_organization_id: 'another' })], 'client', 'client');
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).not.toHaveProperty('employee_number');
    expect(result.lines[0]).not.toHaveProperty('recorded_start');
    for (const privateValue of ['EMP-12', '31.27', '53.46', 'PRIVATE', 'Employee number', 'Recorded start']) {
      expect(result.csv).not.toContain(privateValue);
    }
    expect(result.groups).toEqual([{ name: 'Fixture workplace', hours: 8 }]);
  });

  it('never promotes missing, rejected, unreviewed, finalised or unallocated hours into an export', () => {
    const result = buildShiftHoursExport([
      row({ id: 'unreviewed', review_status: 'needs_review' }),
      row({ id: 'rejected', review_status: 'rejected' }),
      row({ id: 'paid', review_status: 'finalised', can_review_hours: false }),
      row({ id: 'missing', payable_end: null }),
      row({ id: 'unallocated', payroll_adjustment_pending: true }),
      row({ id: 'place', location_name: null }),
    ], 'payroll', null);
    expect(result.lines).toHaveLength(0);
    expect(result.excluded).toHaveLength(6);
    expect(result.totalHours).toBe(0);
    expect(result.csv).toBe('');
    expect(buildShiftHoursExport([row({ client_link_problem: 'Agreement and shift places disagree' })], 'client', 'client').excluded).toHaveLength(1);
    expect(buildShiftHoursExport([row({ can_review_hours: false })], 'payroll', null).excluded).toHaveLength(1);
  });

  it('keeps overnight/DST durations based on instants, not wall-clock subtraction, and rejects invalid break evidence', () => {
    const result = buildShiftHoursExport([row({ payable_start: '2026-09-26T12:00:00Z',
      payable_end: '2026-09-26T15:00:00Z', unpaid_minutes: 0 })], 'payroll', null);
    expect(result.lines[0]).toMatchObject({ start: '2026-09-27 00:00:00 +12:00',
      finish: '2026-09-27 04:00:00 +13:00', hours: 3 });
    for (const unpaid of [-1, 9999, NaN]) {
      expect(buildShiftHoursExport([row({ unpaid_minutes: unpaid })], 'payroll', null).lines).toHaveLength(0);
    }
  });

  it('guards spreadsheet formulas and uses stable source/review versions independent of row ordering', () => {
    const a = row({ staff_name: '=SUM(A1:A5)', location_name: 'Hall, "North"' });
    const b = row({ id: 'shift-2' });
    expect(buildShiftHoursExport([a], 'payroll', null).csv).toContain("'=SUM(A1:A5)");
    expect(buildShiftHoursExport([a], 'payroll', null).csv).toContain('"Hall, ""North"""');
    expect(buildShiftHoursExport([row({ location_name: ' =1+1' })], 'payroll', null).csv).toContain("' =1+1");
    expect(shiftHoursVersion([a, b])).toBe(shiftHoursVersion([b, a]));
    expect(shiftHoursVersion([a])).not.toBe(shiftHoursVersion([row({ review_revision: 2 })]));
    expect(shiftHoursVersion([a])).not.toBe(shiftHoursVersion([row({ source_revision: 'b'.repeat(32) })]));
  });

  it('fails closed on an old or malformed service response instead of claiming no hours', () => {
    expect(parseShiftHoursRows([row()])).toEqual([row()]);
    expect(() => parseShiftHoursRows(null)).toThrow(/review data/i);
    expect(() => parseShiftHoursRows([{ id: 'legacy' }])).toThrow(/review data/i);
    expect(() => parseShiftHoursRows([{ ...row(), review_status: 'paid' }])).toThrow(/review data/i);
  });
});
