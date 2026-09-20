import { describe, expect, it } from 'vitest';
import { credentialExpiryState, credentialExpiryWords, credentialTypeLabel } from './credentialWords';

const now = new Date('2026-09-20T12:00:00+12:00');

describe('credentialTypeLabel', () => {
  it('names known credentials the way the licence reads', () => {
    expect(credentialTypeLabel('security_licence')).toBe('Security licence (PSPLA)');
    expect(credentialTypeLabel('noise_control_warrant')).toBe('Noise control warrant');
  });
  it('never shows snake_case for codes it does not know', () => {
    expect(credentialTypeLabel('site_induction_card')).toBe('Site induction card');
    expect(credentialTypeLabel(null)).toBe('Credential');
  });
});

describe('credentialExpiryWords', () => {
  it('says expired, expiring with the days left, current, or no expiry', () => {
    expect(credentialExpiryState('2026-09-01', now)).toBe('expired');
    expect(credentialExpiryWords('2026-09-01', now)).toBe('Expired 1 Sept 2026');
    expect(credentialExpiryWords('2026-10-01', now)).toBe('Expires 1 Oct 2026 — in 11 days');
    expect(credentialExpiryWords('2026-09-21', now)).toBe('Expires 21 Sept 2026 — tomorrow');
    expect(credentialExpiryWords('2027-03-04', now)).toBe('Expires 4 Mar 2027');
    expect(credentialExpiryWords(null, now)).toBe('No expiry');
  });
});
