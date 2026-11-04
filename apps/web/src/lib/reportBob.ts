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

export type ReviewWording = { title: string; executive_summary: string; client_notes: string; follow_up: string };

export interface PrivacyCheckResult {
  cleared: boolean;
  remaining: number;
  reworded: number;
  /** The reviewer's wording with personal names withheld, when wording was sent. */
  editorial: ReviewWording | null;
  updatedAt: string | null;
  error: string | null;
}

interface PrivacyCheckResponse {
  ok: true;
  checked: number;
  reworded: number;
  editorial_reworded: number;
  remaining: number;
  cleared: boolean;
  updated_at: string;
  editorial?: unknown;
}

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const isPrivacyCheckResponse = (value: unknown): value is PrivacyCheckResponse => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.ok === true && isCount(record.checked) && isCount(record.reworded)
    && isCount(record.editorial_reworded) && isCount(record.remaining)
    && record.cleared === (record.remaining === 0)
    && typeof record.updated_at === 'string' && !Number.isNaN(Date.parse(record.updated_at));
};

const isReviewWording = (value: unknown): value is ReviewWording => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return ['title', 'executive_summary', 'client_notes', 'follow_up'].every((field) => typeof record[field] === 'string');
};

/**
 * Bob's privacy oracle (check-report-privacy): withholds personal names and
 * contact details from everything the client will read. The entries are
 * checked in passes first; the reviewer's unsaved wording, when given, is
 * checked last and returned reworded so exactly that wording is published.
 */
export async function runPrivacyCheck(
  packId: string,
  options: { editorial?: ReviewWording; expectedUpdatedAt?: string } = {},
): Promise<PrivacyCheckResult> {
  const result: PrivacyCheckResult = { cleared: false, remaining: 0, reworded: 0, editorial: null, updatedAt: options.expectedUpdatedAt ?? null, error: null };
  const check = async (editorial?: ReviewWording) => {
    // With a starting version, each pass expects the version left by the previous pass, so another administrator's save stops the check.
    const expected = result.updatedAt ? { expected_updated_at: result.updatedAt } : {};
    const { data, error } = await supabase.functions.invoke<unknown>('check-report-privacy', { body: { pack_id: packId, ...expected, ...(editorial ? { editorial } : {}) } });
    if (error || !data) {
      result.error = await functionErrorMessage(error, 'Bob could not complete the privacy check.');
      return null;
    }
    if (!isPrivacyCheckResponse(data)) {
      result.error = 'Bob returned an invalid privacy-check result; the report was not cleared. Please try again.';
      return null;
    }
    result.reworded += data.reworded + data.editorial_reworded;
    result.remaining = data.remaining;
    result.updatedAt = data.updated_at;
    return data;
  };
  for (let pass = 0; pass < MAX_SCAN_PASSES; pass += 1) {
    const data = await check();
    if (!data) return result;
    if (result.remaining === 0 || data.checked <= 0) break;
  }
  if (result.remaining > 0) return result;
  if (options.editorial) {
    const data = await check(options.editorial);
    if (!data) return result;
    if (!isReviewWording(data.editorial)) {
      result.error = 'Bob returned invalid checked wording; the report was not cleared. Please try again.';
      return result;
    }
    result.editorial = data.editorial;
  }
  result.cleared = result.remaining === 0;
  return result;
}
