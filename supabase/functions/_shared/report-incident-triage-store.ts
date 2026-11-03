// Reads report_incident_triage rows for one pack's period. PostgREST caps a
// response at 1,000 rows and a pack can hold 2,000 activity lines, so the read
// pages through the rows in a stable order (line_key is unique per agreement).

// deno-lint-ignore no-explicit-any
type Query = any;

export interface TriageScope {
  service_agreement_id: string | null;
  period_start: string;
  period_end: string;
}

const PAGE_SIZE = 1000;

export async function readPackTriage<T>(
  admin: { from: (table: string) => Query },
  pack: TriageScope,
  columns: string,
  narrow: (query: Query) => Query = (query) => query,
): Promise<{ data: T[]; error: string | null }> {
  // Triage is keyed by agreement; a pack without one has no decisions.
  if (!pack.service_agreement_id) return { data: [], error: null };
  const rows: T[] = [];
  for (let start = 0; ; start += PAGE_SIZE) {
    const { data, error } = await narrow(
      admin.from('report_incident_triage').select(columns)
        .eq('service_agreement_id', pack.service_agreement_id)
        .gte('line_date', pack.period_start)
        .lte('line_date', pack.period_end),
    ).order('line_key').range(start, start + PAGE_SIZE - 1);
    if (error) return { data: [], error: String(error.message ?? error) };
    const page = (data ?? []) as T[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) return { data: rows, error: null };
  }
}

export interface ConfirmedIncident {
  line_key: string;
  decision: string;
  incident_type: string | null;
}

/** Entries a reviewer confirmed as incidents for this pack's period. */
export function readConfirmedIncidents(admin: { from: (table: string) => Query }, pack: TriageScope) {
  return readPackTriage<ConfirmedIncident>(admin, pack, 'line_key,decision,incident_type', (query) => query.eq('decision', 'incident'));
}