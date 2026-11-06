const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validReportShiftId(value: string | null): value is string {
  return value !== null && UUID.test(value);
}

export function resolveReportShift(
  availableIds: string[], requestedId: string | null, currentId: string | null,
): { shiftId: string; error: string | null } {
  const selected = currentId ?? requestedId;
  if (selected === null) return { shiftId: availableIds[0] ?? '', error: null };
  if (currentId === '') return { shiftId: '', error: null };
  if (!validReportShiftId(selected)) return {
    shiftId: selected || '__invalid_shift__',
    error: 'The requested shift context is invalid. Choose an available assigned shift or explicitly choose No related shift.',
  };
  if (!availableIds.includes(selected)) return {
    shiftId: selected,
    error: 'The requested or selected shift is unavailable for your account. Choose an available assigned shift or explicitly choose No related shift.',
  };
  return { shiftId: selected, error: null };
}

export function reportReceiptMatchesShift(
  value: unknown, selectedShiftId: string | null,
): value is { id: string; received_at: string; shift_id: string | null } {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return typeof row.id === 'string' && UUID.test(row.id)
    && typeof row.received_at === 'string' && Number.isFinite(Date.parse(row.received_at))
    && row.shift_id === selectedShiftId;
}
