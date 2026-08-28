/**
 * _shared/mr-review-utils.ts — Pure utility functions for MR review.
 *
 * Shared between bob-review-merge-request (edge fn) and its unit tests.
 * These are the ACTUAL functions the runtime uses — not mirrors.
 *
 * DETERMINISTIC + PURE: no LLM, no network, no DB. Safe to run in a plain
 * `deno test` with no environment.
 */ /**
 * Extract MR iid from a GitLab MR URL.
 * Handles URLs like:
 *   https://gitlab.com/group/project/-/merge_requests/1234
 *   https://gitlab.com/group/sub/project/-/merge_requests/1234
 *   https://gitlab.com/group/project/-/merge_requests/1234/diffs
 */ export function extractIidFromUrl(url) {
  const match = url.match(/merge_requests\/(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}
/**
 * Build the GitLab API path for an MR metadata fetch.
 * Returns the path segment AFTER /api/v4/projects/{id}.
 */ export function buildMrMetadataPath(iid) {
  return `/merge_requests/${iid}`;
}
/**
 * Build the GitLab API path for an MR diffs fetch.
 * Returns the path segment AFTER /api/v4/projects/{id}.
 */ export function buildMrDiffsPath(iid, perPage = 100) {
  return `/merge_requests/${iid}/diffs?per_page=${perPage}`;
}
/**
 * Build the full GitLab API URL for a project-scoped path.
 * This is the URL construction logic used by the gl() helper in the edge fn.
 */ export function buildGitLabApiUrl(baseUrl, projectId, path) {
  return `${baseUrl}/api/v4/projects/${encodeURIComponent(projectId)}${path}`;
}
/**
 * Check whether the fetched MR identity matches the requested iid.
 * Returns { match: true } or { match: false, requested, fetched }.
 */ export function checkIdentityMatch(requestedIid, fetchedIid) {
  // Guard: typeof NaN === 'number' is true, so we must also check
  // Number.isFinite to avoid storing NaN as a valid fetched iid.
  // A NaN fetched iid must resolve to null (non-match), never silently
  // compare as a valid number (which would always fail === and produce
  // a false mismatch that blocks a valid review).
  const fetched = typeof fetchedIid === 'number' && Number.isFinite(fetchedIid) ? fetchedIid : null;
  return {
    match: fetched !== null && requestedIid === fetched,
    requested: requestedIid,
    fetched
  };
}
