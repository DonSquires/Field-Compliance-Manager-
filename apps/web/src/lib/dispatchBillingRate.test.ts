import { describe, expect, it } from 'vitest';
import { resolveDispatchBillingRule, type DispatchBillingRule } from './dispatchBillingRate';

const base: DispatchBillingRule = {
  id: 'wildcard', amount: 100, rateType: 'flat', clientOrgId: null, siteId: null,
  zoneId: null, jobType: null, priority: 0, effectiveFrom: null, effectiveTo: null,
};

describe('dispatch billing rate resolution', () => {
  it('prefers site and job-specific rules over wildcard rules', () => {
    const selected = resolveDispatchBillingRule([
      base,
      { ...base, id: 'specific', amount: 175, clientOrgId: 'client-1', siteId: 'site-1', jobType: 'alarm_response' },
    ], { clientOrgId: 'client-1', siteId: 'site-1', jobType: 'alarm_response', onDate: '2026-08-30' });
    expect(selected?.id).toBe('specific');
  });

  it('rejects expired and wrong-client rules', () => {
    expect(resolveDispatchBillingRule([
      { ...base, id: 'expired', effectiveTo: '2026-08-29' },
      { ...base, id: 'wrong-client', clientOrgId: 'client-2' },
    ], { clientOrgId: 'client-1', siteId: 'site-1', jobType: 'incident', onDate: '2026-08-30' })).toBeNull();
  });

  it('uses priority to break equal-specificity matches', () => {
    const selected = resolveDispatchBillingRule([
      { ...base, id: 'low', clientOrgId: 'client-1', priority: 1 },
      { ...base, id: 'high', clientOrgId: 'client-1', priority: 10 },
    ], { clientOrgId: 'client-1', siteId: 'site-1', jobType: 'incident', onDate: '2026-08-30' });
    expect(selected?.id).toBe('high');
  });
});