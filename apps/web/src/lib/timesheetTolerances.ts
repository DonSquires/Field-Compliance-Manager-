function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function outsideTolerance(actual: unknown, planned: unknown): boolean {
  if (typeof actual !== 'string' || typeof planned !== 'string') return false;
  const difference = Math.abs(Date.parse(actual) - Date.parse(planned));
  return Number.isFinite(difference) && difference > 15 * 60_000;
}

export function timesheetMismatchReasons(value: unknown): string[] {
  const metadata = record(value);
  const reasons: string[] = [];
  if (metadata.start_mismatch === true || outsideTolerance(metadata.actual_start, metadata.scheduled_start)) {
    reasons.push('Start time does not match roster');
  }
  if (metadata.finish_mismatch === true || outsideTolerance(metadata.actual_end, metadata.scheduled_end)) {
    reasons.push('Finish time does not match roster');
  }
  if (metadata.unpaid_break_mismatch === true) reasons.push('Mandatory unpaid break does not match roster');
  return reasons;
}

export function timesheetSummaryMismatchReasons(value: unknown): string[] {
  const summary = record(value);
  if (!Array.isArray(summary.entries)) return [];
  return [...new Set(summary.entries.flatMap((entry) => timesheetMismatchReasons(record(entry).metadata)))];
}

export function shiftHoursReviewStatus(status: string, metadata: unknown): 'confirmed' | 'review' | 'missed' | 'pending' {
  if (status === 'missed') return 'missed';
  if (status !== 'completed') return 'pending';
  const evidence = record(metadata);
  if (typeof evidence.actual_start !== 'string' || typeof evidence.actual_end !== 'string'
    || !Number.isFinite(Date.parse(evidence.actual_start)) || !Number.isFinite(Date.parse(evidence.actual_end))
    || Date.parse(evidence.actual_end) <= Date.parse(evidence.actual_start)
    || typeof evidence.scheduled_start !== 'string' || typeof evidence.scheduled_end !== 'string'
    || !Number.isFinite(Date.parse(evidence.scheduled_start)) || !Number.isFinite(Date.parse(evidence.scheduled_end))) return 'review';
  return timesheetMismatchReasons(metadata).length || evidence.manual_correction === true ? 'review' : 'confirmed';
}