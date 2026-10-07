export const ACTIVITY_PAGE_SIZE = 25;

/** PostgREST `or()` filters are comma/paren delimited, so user text must not carry those through. */
export function sanitiseSearchTerm(raw: string): string {
  return raw.replace(/[,()*%\\:"']/g, ' ').replace(/\s+/g, ' ').trim();
}
