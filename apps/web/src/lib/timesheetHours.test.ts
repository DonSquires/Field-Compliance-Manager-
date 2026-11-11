import { describe, expect, it } from 'vitest';
import { timesheetPaidHours, timesheetWorkedHours } from './timesheetHours';

describe('timesheet hour totals', () => {
  it('reports hours worked from the recorded shift work, not the payroll figure', () => {
    expect(timesheetWorkedHours({ work_derived_hours: 7.5, actual_hours: 8 })).toBe(7.5);
    expect(timesheetWorkedHours({ work_derived_hours: null, actual_hours: 8 })).toBeNull();
  });

  it('reports paid hours the same way payroll export and labour costing do', () => {
    expect(timesheetPaidHours({ work_derived_hours: 7.5, actual_hours: 8 })).toBe(8);
    expect(timesheetPaidHours({ work_derived_hours: 7.5, actual_hours: null })).toBe(7.5);
    expect(timesheetPaidHours({ work_derived_hours: null, actual_hours: null })).toBeNull();
  });

  it('keeps PostgREST numeric strings as numbers', () => {
    expect(timesheetPaidHours({ work_derived_hours: '7.50', actual_hours: '8.25' })).toBe(8.25);
    expect(timesheetWorkedHours({ work_derived_hours: '7.50', actual_hours: null })).toBe(7.5);
  });
});
