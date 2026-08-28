import { describe, expect, it } from 'vitest';
import { getModuleAccessMessage } from './moduleAccessMessage';

describe('getModuleAccessMessage', () => {
  it('gives distinct outcomes for loading, error, and unconfigured — never the same message', () => {
    const loading = getModuleAccessMessage('loading', false, { moduleLabel: 'Welfare' });
    const error = getModuleAccessMessage('error', false, { moduleLabel: 'Welfare' });
    const unconfigured = getModuleAccessMessage('unconfigured', false, { moduleLabel: 'Welfare', safetyRelevant: true });
    expect(new Set([loading.description, error.description, unconfigured.description]).size).toBe(3);
  });

  it('never shows a safety-relevant module while loading or on error, and says configuration could not be verified', () => {
    const loading = getModuleAccessMessage('loading', false, { moduleLabel: 'Welfare', safetyRelevant: true });
    const error = getModuleAccessMessage('error', false, { moduleLabel: 'Welfare', safetyRelevant: true });
    expect(loading.tone).toBe('blocked');
    expect(error.tone).toBe('blocked');
    expect(error.description).toMatch(/could not be verified/i);
  });

  it('says "not enabled for this organisation" for a configured-but-disabled module, and explicitly rules out missing/broken rather than describing it as such', () => {
    const msg = getModuleAccessMessage('configured', false, { moduleLabel: 'Welfare Monitoring', safetyRelevant: true });
    expect(msg.tone).toBe('unavailable');
    expect(msg.description).toMatch(/not enabled for this organisation/i);
    expect(msg.description).not.toMatch(/^Welfare Monitoring is (missing|broken)\./i);
  });

  it('allows a non-safety module to appear on a genuinely unconfigured org, but still blocks a safety-relevant one', () => {
    const nonSafety = getModuleAccessMessage('unconfigured', false, { moduleLabel: 'Field Reports' });
    const safety = getModuleAccessMessage('unconfigured', false, { moduleLabel: 'Welfare', safetyRelevant: true });
    expect(nonSafety.tone).toBe('visible');
    expect(safety.tone).toBe('blocked');
  });

  it('every non-visible outcome includes a compact explanation and a responsible scope, never a bare dead end', () => {
    const outcomes = [
      getModuleAccessMessage('error', false, { moduleLabel: 'Welfare', safetyRelevant: true }),
      getModuleAccessMessage('unconfigured', false, { moduleLabel: 'Welfare', safetyRelevant: true }),
      getModuleAccessMessage('configured', false, { moduleLabel: 'Welfare', safetyRelevant: true }),
    ];
    for (const outcome of outcomes) {
      expect(outcome.description.length).toBeGreaterThan(0);
      expect(outcome.description).toMatch(/administrator|try again/i);
    }
  });

  it('confirms an enabled configured module is visible with no blocking language', () => {
    const msg = getModuleAccessMessage('configured', true, { moduleLabel: 'Welfare', safetyRelevant: true });
    expect(msg.tone).toBe('visible');
  });
});
