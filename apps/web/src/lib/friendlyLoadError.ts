/**
 * friendlyLoadError.ts — turns raw Postgres/PostgREST error text into copy a
 * field officer or admin can act on, instead of surfacing strings like
 * "JSON object requested, multiple (or no) rows returned" directly in the UI.
 * The raw error is still logged to the console for debugging.
 */
export function describeLoadFailures(
  labelledErrors: Array<[label: string, error: { message: string } | null | undefined]>,
): string | null {
  const failed = labelledErrors.filter(([, error]) => Boolean(error));
  if (!failed.length) return null;
  // eslint-disable-next-line no-console
  console.error('Data load failed', Object.fromEntries(failed.map(([label, error]) => [label, error])));
  const labels = failed.map(([label]) => label);
  return `We couldn't load ${labels.join(', ')}. Try refreshing — contact your administrator if this continues.`;
}
