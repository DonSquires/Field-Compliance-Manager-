type HoursValue = number | string | null | undefined;

export interface TimesheetHourSource {
  work_derived_hours?: HoursValue;
  actual_hours?: HoursValue;
}

const toHours = (value: HoursValue): number | null => value === null || value === undefined || value === '' ? null : Number(value);

/** Time recorded on the officer's shifts, unpaid breaks removed. */
export const timesheetWorkedHours = (sheet: TimesheetHourSource): number | null => toHours(sheet.work_derived_hours);

/** The hours payroll pays: matches create_payroll_export_batch and labour-cost posting (actual_hours, else work_derived_hours). */
export const timesheetPaidHours = (sheet: TimesheetHourSource): number | null => toHours(sheet.actual_hours) ?? toHours(sheet.work_derived_hours);
