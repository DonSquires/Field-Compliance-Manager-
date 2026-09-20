import { describe, expect, it } from 'vitest';
import { readAuthLinkType } from './authLink';

describe('readAuthLinkType', () => {
  it('recognises the invite and recovery links Supabase sends', () => {
    expect(readAuthLinkType('#access_token=abc&expires_in=3600&refresh_token=def&token_type=bearer&type=invite')).toBe('invite');
    expect(readAuthLinkType('#access_token=abc&type=recovery')).toBe('recovery');
  });
  it('is null for a plain page load or an unknown type', () => {
    expect(readAuthLinkType('')).toBeNull();
    expect(readAuthLinkType('#section-2')).toBeNull();
    expect(readAuthLinkType('#type=something_else')).toBeNull();
  });
});
