import { supabase } from './supabase';

/** Scan passes per run: each covers about a minute of Bob's reading. */
export const MAX_SCAN_PASSES = 8;

export async function functionErrorMessage(error: unknown, fallback: string): Promise<string> {
  const context = (error as { context?: unknown } | null)?.context;
  if (context instanceof Response) {
    const body = await context.clone().json().catch(() => null) as { error?: unknown } | null;
    if (typeof body?.error === 'string' && body.error) return body.error;
  }
  return error instanceof Error && error.message ? error.message : fallback;
}

export interface IncidentScanResult {
  checked: number;
  flagged: number;
  remaining: number;
  notItemised: number;
  error: string | null;
}

/**
 * Bob reads the pack's logged activity and officer notes and highlights
 * possible incidents for the reviewer (flag-report-potential-incidents), in
 * passes until every entry is checked or MAX_SCAN_PASSES is reached. Without
 * rescanBefore only entries Bob has not checked yet are read.
 */
export async function runIncidentScan(packId: string, options: { rescanBefore?: string; onProgress?: (checked: number) => void } = {}): Promise<IncidentScanResult> {
  const result: IncidentScanResult = { checked: 0, flagged: 0, remaining: 0, notItemised: 0, error: null };
  for (let pass = 0; pass < MAX_SCAN_PASSES; pass += 1) {
    options.onProgress?.(result.checked);
    const { data, error } = await supabase.functions.invoke('flag-report-potential-incidents', {
      body: { pack_id: packId, ...(options.rescanBefore ? { rescan_before: options.rescanBefore } : {}) },
    });
    if (error || !data) {
      result.error = await functionErrorMessage(error, 'Bob could not check the entries.');
      return result;
    }
    const checked = Number(data.checked) || 0;
    result.checked += checked;
    result.flagged += Number(data.flagged) || 0;
    result.remaining = Number(data.remaining) || 0;
    result.notItemised = Number(data.not_itemised) || 0;
    if (result.remaining === 0 || checked <= 0) break;
  }
  return result;
}

export interface SummaryDraftResult {
  saved: boolean;
  skipped: string | null;
  error: string | null;
}

/** Bob drafts the executive summary and stores it only when the draft pack has none yet. */
export async function draftSummaryIfEmpty(packId: string): Promise<SummaryDraftResult> {
  const { data, error } = await supabase.functions.invoke('draft-report-executive-summary', { body: { pack_id: packId, save_if_empty: true } });
  if (error || !data) return { saved: false, skipped: null, error: await functionErrorMessage(error, 'Bob could not draft the executive summary.') };
  return { saved: data.saved === true, skipped: typeof data.skipped === 'string' ? data.skipped : null, error: null };
}
