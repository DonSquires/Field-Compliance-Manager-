import { describe, expect, it } from 'vitest';
import { permitAnswer, permitIsCurrent, permitValidity, permitValidityLabel } from './permits';

// 12:00 UTC on 28 Feb is already 1 March in New Zealand (NZDT, UTC+13).
const now = new Date('2026-02-28T12:00:00Z');
const permit = (overrides: Record<string, unknown>) => ({ status: 'active', date_from: null, date_to: null, ...overrides });

describe('permit validity', () => {
  it('prefers the validity the server derived', () => {
    expect(permitValidity(permit({ validity_state: 'expired', date_to: '2099-01-01' }), now)).toBe('expired');
  });

  it('derives validity from the dates on the New Zealand calendar day', () => {
    expect(permitValidity(permit({ date_to: '2026-02-28' }), now)).toBe('expired');
    expect(permitValidity(permit({ date_to: '2026-03-01' }), now)).toBe('expiring_soon');
    expect(permitValidity(permit({ date_to: '2026-03-31' }), now)).toBe('expiring_soon');
    expect(permitValidity(permit({ date_to: '2026-04-01' }), now)).toBe('valid');
    expect(permitValidity(permit({ date_from: '2026-03-02', date_to: '2026-12-31' }), now)).toBe('not_started');
    expect(permitValidity(permit({ date_from: '2026-03-01' }), now)).toBe('valid');
    expect(permitValidity(permit({}), now)).toBe('dates_not_recorded');
  });

  it('keeps an administrative stop ahead of the dates', () => {
    expect(permitValidity(permit({ status: 'revoked', date_to: '2099-01-01' }), now)).toBe('revoked');
    expect(permitValidity(permit({ status: 'suspended' }), now)).toBe('suspended');
  });

  it('labels states plainly and treats only valid or expiring permits as current', () => {
    expect(permitValidityLabel('dates_not_recorded')).toBe('Dates not recorded');
    expect(permitIsCurrent('expiring_soon')).toBe(true);
    expect(permitIsCurrent('not_started')).toBe(false);
    expect(permitAnswer(true)).toBe('Yes');
    expect(permitAnswer(false, 'Valid', 'Not valid')).toBe('Not valid');
    expect(permitAnswer(null)).toBe('Not recorded');
  });
});
