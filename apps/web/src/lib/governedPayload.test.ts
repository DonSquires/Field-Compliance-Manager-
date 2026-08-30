import { describe, expect, it } from 'vitest';
import { formatGovernedPayload, sanitizeGovernedPayload } from './governedPayload';

describe('governed payload display', () => {
  it('redacts secret-like keys recursively while preserving reviewable fields', () => {
    expect(sanitizeGovernedPayload({
      organization_id: 'org-1',
      api_key: 'secret-value',
      nested: { password: 'hidden', name: 'Site A' },
      rows: [{ accessToken: 'token', id: 'row-1' }],
    })).toEqual({
      organization_id: 'org-1',
      api_key: '[REDACTED]',
      nested: { password: '[REDACTED]', name: 'Site A' },
      rows: [{ accessToken: '[REDACTED]', id: 'row-1' }],
    });
  });

  it('formats a stable readable JSON review', () => {
    expect(formatGovernedPayload({ action: 'create', token: 'hidden' })).toContain('"token": "[REDACTED]"');
  });
});