export interface ImportedLabourRefs {
  source?: string;
  recorded_hours?: number;
  time_precision?: string;
  pay_code?: string;
  source_records?: unknown[];
  client_name?: string;
  route_code?: string;
  route_basis?: string;
}

export function importedLabourLabel(refs: ImportedLabourRefs | null | undefined): string | null {
  if (refs?.source !== 'rm_patrol_log_labour') return null;
  const hours = typeof refs.recorded_hours === 'number' && Number.isFinite(refs.recorded_hours)
    ? `${Number(refs.recorded_hours.toFixed(2))}h recorded`
    : 'Hours not recorded';
  const count = refs.source_records?.length ?? 0;
  // Once routed onto a patrol route row, the client is no longer implied by the row name.
  const client = typeof refs.client_name === 'string' && refs.client_name.trim() ? ` · ${refs.client_name.trim()}` : '';
  return `Patrol log${client} · ${hours} · ${count} source ${count === 1 ? 'entry' : 'entries'} · start approximate`;
}

export function isPricedRosterLabour(status: string): boolean {
  return status === 'resolved' || status === 'billed_via_patrol_log' || status === 'billed_via_work_order';
}
