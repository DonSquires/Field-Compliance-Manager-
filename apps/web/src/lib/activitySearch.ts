export const ACTIVITY_PAGE_SIZE = 25;

/** PostgREST `or()` filters are comma/paren delimited, so user text must not carry those through. */
export function sanitiseSearchTerm(raw: string): string {
  return raw.replace(/[,()*%\\:"']/g, ' ').replace(/\s+/g, ' ').trim();
}

export const ACTIVITY_SEARCH_MIN_LENGTH = 2;

/** Search terms go to a parameterised RPC, so punctuation (apostrophes, slashes) is kept; only whitespace is collapsed. */
export function normaliseSearchTerm(raw: string): string {
  const term = raw.replace(/\s+/g, ' ').trim();
  return term.length >= ACTIVITY_SEARCH_MIN_LENGTH ? term.slice(0, 200) : '';
}
