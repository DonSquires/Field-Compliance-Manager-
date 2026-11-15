import { toCsv } from './nztaRegister';
import { shiftHoursFigures, type ShiftHoursSource } from './shiftHoursTotals';

export interface ShiftHoursReviewRow extends ShiftHoursSource {
  id: string;
  organization_id: string;
  officer_user_id: string | null;
  staff_id: string | null;
  staff_name: string | null;
  service_type: string;
  status: string;
  updated_at: string;
  scheduled_start: string;
  scheduled_end: string;
  actual_start: string | null;
  actual_end: string | null;
  payable_start: string | null;
  payable_end: string | null;
  unpaid_minutes: number;
  recorded_unpaid_minutes: number;
  planned_unpaid_minutes: number;
  correction_updated_at: string | null;
  correction_reason: string | null;
  manual_update?: boolean;
  hours_status: 'confirmed' | 'review' | 'missed' | 'pending';
  start_mismatch: boolean;
  finish_mismatch: boolean;
  unpaid_break_mismatch: boolean;
  source_revision: string;
  review_revision: number;
  review_status: 'needs_review' | 'approved' | 'rejected' | 'finalised';
  can_edit_hours: boolean;
  can_review_hours: boolean | null;
  client_organization_id: string | null;
  client_name: string | null;
  service_agreement_id: string | null;
  location_name: string | null;
  client_link_problem: string | null;
  payroll_adjustment_pending: boolean;
  employee_number?: string | null;
  review_reason?: string | null;
}

export type ShiftHoursExportMode = 'payroll' | 'client';
export interface ShiftHoursExportLine extends Record<string, unknown> {
  reference: string;
  staff_name: string;
  location: string;
  client: string;
  start: string;
  finish: string;
  unpaid_minutes: number;
  hours: number;
}
export interface ShiftHoursExport {
  lines: ShiftHoursExportLine[];
  excluded: { id: string; name: string; reason: string }[];
  groups: { name: string; hours: number }[];
  totalHours: number;
  csv: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const nullableString = (value: unknown) => value === null || typeof value === 'string';
const validRow = (value: unknown): value is ShiftHoursReviewRow => isRecord(value)
  && ['id', 'organization_id', 'service_type', 'status', 'updated_at', 'scheduled_start', 'scheduled_end', 'source_revision']
    .every((key) => typeof value[key] === 'string' && value[key] !== '')
  && ['officer_user_id', 'staff_id', 'staff_name', 'actual_start', 'actual_end', 'payable_start', 'payable_end',
    'correction_updated_at', 'correction_reason', 'client_organization_id', 'client_name',
    'service_agreement_id', 'location_name', 'client_link_problem'].every((key) => nullableString(value[key]))
  && ['unpaid_minutes', 'recorded_unpaid_minutes', 'planned_unpaid_minutes', 'review_revision']
    .every((key) => typeof value[key] === 'number' && Number.isFinite(value[key]))
  && ['can_edit_hours', 'start_mismatch', 'finish_mismatch', 'unpaid_break_mismatch', 'payroll_adjustment_pending']
    .every((key) => typeof value[key] === 'boolean')
  && (value.can_review_hours === null || typeof value.can_review_hours === 'boolean')
  && ['needs_review', 'approved', 'rejected', 'finalised'].includes(String(value.review_status))
  && ['confirmed', 'review', 'missed', 'pending'].includes(String(value.hours_status));

export function parseShiftHoursRows(value: unknown): ShiftHoursReviewRow[] {
  if (!Array.isArray(value) || !value.every(validRow)) {
    throw new Error('Shift review data is incomplete or out of date. Refresh after the service update; no hours have been exported.');
  }
  return value;
}

export function shiftHoursVersion(rows: ShiftHoursReviewRow[]): string {
  return JSON.stringify(rows.map((row) => [row.id, row.source_revision, row.review_revision, row.review_status])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
}

export function nzHoursTimestamp(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('A shift timestamp is invalid. Correct its source before exporting.');
  const parts = new Intl.DateTimeFormat('en-NZ', {
    timeZone: 'Pacific/Auckland', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset',
  }).formatToParts(date);
  const part = (key: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === key)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}:${part('second')} ${part('timeZoneName').replace('GMT', '')}`;
}

const roundHours = (hours: number) => Math.round(hours * 100) / 100;
function exclusion(row: ShiftHoursReviewRow, mode: ShiftHoursExportMode): string | null {
  if (row.review_status === 'finalised') return 'Finalised payroll evidence: an amendment is required, not another hours export.';
  if (row.review_status !== 'approved') return row.review_status === 'rejected' ? 'Rejected: correct and approve again.' : 'Human hours approval required.';
  if (row.payroll_adjustment_pending) return 'Payroll adjustment has not been allocated to source work.';
  if (!row.staff_id || !row.staff_name?.trim()) return 'Staff identity is missing.';
  if (!row.location_name?.trim()) return 'Worked location is missing.';
  if (!row.payable_start || !row.payable_end) return 'Payable start or finish is missing.';
  const minutes = (Date.parse(row.payable_end) - Date.parse(row.payable_start)) / 60000;
  if (!Number.isFinite(minutes) || minutes <= 0 || !Number.isFinite(row.unpaid_minutes)
    || row.unpaid_minutes < 0 || row.unpaid_minutes > minutes) return 'Payable times or unpaid break are invalid.';
  if (mode === 'payroll' && !row.can_review_hours) return 'Employer payroll review permission is required.';
  if (mode === 'client' && (!row.client_organization_id || !row.service_agreement_id || row.client_link_problem)) {
    return row.client_link_problem ?? 'Agreement recipient is missing.';
  }
  return null;
}

export function buildShiftHoursExport(
  rows: ShiftHoursReviewRow[], mode: ShiftHoursExportMode, clientId: string | null,
): ShiftHoursExport {
  if (mode === 'client' && !clientId) throw new Error('Choose a client before previewing their hours.');
  const result: ShiftHoursExport = { lines: [], excluded: [], groups: [], totalHours: 0, csv: '' };
  const grouped = new Map<string, { name: string; hours: number }>();
  for (const row of rows) {
    if (mode === 'client' && row.client_organization_id !== clientId) continue;
    const problem = exclusion(row, mode);
    if (problem) { result.excluded.push({ id: row.id, name: row.staff_name ?? 'Staff identity unavailable', reason: problem }); continue; }
    const hours = shiftHoursFigures(row).payHours!;
    const line: ShiftHoursExportLine = {
      reference: row.id, staff_name: row.staff_name!, location: row.location_name!, client: row.client_name ?? '',
      start: nzHoursTimestamp(row.payable_start), finish: nzHoursTimestamp(row.payable_end),
      unpaid_minutes: row.unpaid_minutes, hours, approval: 'Approved',
    };
    if (mode === 'payroll') Object.assign(line, { employee_number: row.employee_number ?? '',
      staff_reference: row.staff_id, recorded_start: nzHoursTimestamp(row.actual_start), recorded_finish: nzHoursTimestamp(row.actual_end) });
    result.lines.push(line);
    const groupId = mode === 'payroll' ? row.staff_id! : row.location_name!;
    const group = grouped.get(groupId) ?? { name: mode === 'payroll' ? row.staff_name! : row.location_name!, hours: 0 };
    group.hours = roundHours(group.hours + hours);
    grouped.set(groupId, group);
    result.totalHours = roundHours(result.totalHours + hours);
  }
  result.groups = [...grouped.values()];
  if (!result.lines.length) return result;
  const columns: Array<[string, string]> = [
    ['record_type', 'Row type'], ['staff_name', 'Staff member'],
    ...(mode === 'payroll' ? [['employee_number', 'Employee number'], ['staff_reference', 'Staff reference']] as Array<[string, string]> : []),
    ['location', 'Location worked'], ['client', 'Agreement client'], ['start', 'Payable start (Pacific/Auckland)'],
    ['finish', 'Payable finish (Pacific/Auckland)'], ['unpaid_minutes', 'Unpaid break minutes'], ['hours', 'Shift payable hours'],
    ['approval', 'Hours approval'], ['reference', 'Shift reference'],
    ...(mode === 'payroll' ? [['recorded_start', 'Recorded start (Pacific/Auckland)'], ['recorded_finish', 'Recorded finish (Pacific/Auckland)']] as Array<[string, string]> : []),
    ['summary', 'Summary'], ['summary_hours', 'Summary hours'],
  ];
  result.csv = toCsv([
    ...result.lines.map((line) => ({ record_type: 'Shift', ...line })),
    ...result.groups.map((group) => ({ record_type: mode === 'payroll' ? 'Staff total' : 'Location total', summary: group.name, summary_hours: group.hours })),
    { record_type: 'Grand total', summary: 'All included shifts', summary_hours: result.totalHours },
  ], columns);
  return result;
}
