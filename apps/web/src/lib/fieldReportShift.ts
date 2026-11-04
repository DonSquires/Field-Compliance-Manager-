interface ReportShift {
  id: string;
  status: string;
  scheduled_start: string;
}

export function defaultFieldReportShift(shifts: ReportShift[], now = Date.now()): string {
  const active = shifts.find((shift) => shift.status === 'in_progress');
  if (active) return active.id;
  return [...shifts]
    .filter((shift) => new Date(shift.scheduled_start).getTime() <= now)
    .sort((left, right) => Date.parse(right.scheduled_start) - Date.parse(left.scheduled_start))[0]?.id ?? '';
}
