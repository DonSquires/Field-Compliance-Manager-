import { describe, expect, it } from 'vitest';
import { getAlertResolvedMessage, getDetectionStatusMessage } from './safetyStatusMessage';

describe('getDetectionStatusMessage', () => {
  it('gives a distinct message for every detection state', () => {
    const messages = (['active', 'disabled_by_org', 'disabled_by_officer', 'unknown'] as const).map(
      getDetectionStatusMessage,
    );
    expect(new Set(messages).size).toBe(4);
  });

  it('distinguishes org-level from officer-level disablement in wording', () => {
    expect(getDetectionStatusMessage('disabled_by_org')).toMatch(/organisation/i);
    expect(getDetectionStatusMessage('disabled_by_officer')).toMatch(/your personal settings/i);
  });
});

describe('getAlertResolvedMessage', () => {
  it('never says an alert simply vanished — it always names the explicit action that cleared it', () => {
    const checkIn = getAlertResolvedMessage('check_in');
    const acknowledge = getAlertResolvedMessage('acknowledge');
    expect(checkIn).toMatch(/checked in/i);
    expect(acknowledge).toMatch(/acknowledged/i);
    expect(checkIn).not.toBe(acknowledge);
  });
});
