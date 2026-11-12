const GITHUB_PULL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/\d+\/?$/;

/** The GitHub Actions run list for a pull request's branch, or null when the URL is not a GitHub PR. */
export function githubChecksUrl(prUrl: string | null | undefined, branch: string | null | undefined): string | null {
  const match = GITHUB_PULL.exec(String(prUrl ?? ''));
  if (!match) return null;
  const actions = `https://github.com/${match[1]}/${match[2]}/actions`;
  return branch ? `${actions}?query=${encodeURIComponent(`branch:${branch}`)}` : actions;
}
