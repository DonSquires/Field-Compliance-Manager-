import { describe, expect, it } from 'vitest';
import { githubChecksUrl } from './githubLinks';

describe('githubChecksUrl', () => {
  it('points a GitHub pull request at the Actions runs for its branch', () => {
    expect(githubChecksUrl('https://github.com/DonSquires/Field-Compliance-Manager-/pull/421', 'bob/vibe-1291e194'))
      .toBe('https://github.com/DonSquires/Field-Compliance-Manager-/actions?query=branch%3Abob%2Fvibe-1291e194');
  });

  it('falls back to all Actions runs when the branch is unknown', () => {
    expect(githubChecksUrl('https://github.com/o/r/pull/7/', null)).toBe('https://github.com/o/r/actions');
  });

  it('returns null for retired or foreign hosts and malformed URLs', () => {
    expect(githubChecksUrl('https://git.fcmanager.co.nz/bob/fcm/pulls/10', 'bob/job-1')).toBeNull();
    expect(githubChecksUrl('https://github.com.evil.example/o/r/pull/1', 'x')).toBeNull();
    expect(githubChecksUrl('not a url', 'x')).toBeNull();
    expect(githubChecksUrl(null, 'x')).toBeNull();
  });
});
