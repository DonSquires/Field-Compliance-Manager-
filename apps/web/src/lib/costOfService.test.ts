import { describe, expect, it } from 'vitest';
import { missingSteps, monthWindow, normaliseCostOfService } from './costOfService';

describe('normaliseCostOfService', () => {
  it('rejects an unknown payload version', () => {
    expect(() => normaliseCostOfService({ version: 2 })).toThrow(/unexpected format/);
    expect(() => normaliseCostOfService(null)).toThrow();
  });

  it('coerces numeric strings and drops rows without an agreement id', () => {
    const result = normaliseCostOfService({
      version: 1,
      window: { from: '2026-11-01', to: '2026-11-30' },
      agreements: [
        { agreementId: 'a', agreementName: 'A', posted: { total: '12.5', byType: [{ costType: 'labour', total: '12.5' }] },
          labour: { hours: '7.5', missingSteps: { noTimesheet: 2 } }, callouts: {} },
        { agreementName: 'orphan' },
      ],
    });
    expect(result.agreements).toHaveLength(1);
    expect(result.agreements[0].posted.total).toBe(12.5);
    expect(result.agreements[0].labour.hours).toBe(7.5);
    expect(result.agreements[0].labour.missingSteps.noTimesheet).toBe(2);
    expect(result.agreements[0].clientName).toBeNull();
    expect(result.unattributed).toEqual({ workedShifts: 0, hours: 0, completedJobs: 0 });
  });
});

describe('missingSteps', () => {
  it('names each gap with a real admin destination', () => {
    const [row] = normaliseCostOfService({ version: 1, agreements: [{ agreementId: 'a',
      labour: { rateUnresolvedShifts: 1, missingSteps: { noTimesheet: 1, timesheetNotApproved: 2, approvedNotPosted: 1 } },
      callouts: { unresolvedPayLines: 1, jobsWithoutPayLines: 2 } }] }).agreements;
    const steps = missingSteps(row);
    expect(steps.map((step) => step.key)).toEqual(['no-timesheet', 'not-approved', 'not-posted', 'rate', 'callout-rate', 'callout-pay']);
    expect(steps[0].text).toBe('1 worked shift has no timesheet.');
    expect(steps[1].text).toBe('2 timesheets are awaiting approval.');
    expect(steps[2].href).toBe('/admin/finance-money');
    expect(steps[3].href).toBe('/admin/rate-rules');
  });
});

describe('monthWindow', () => {
  it('covers whole calendar months including the current one', () => {
    expect(monthWindow(3, new Date(2026, 10, 15))).toEqual({ from: '2026-09-01', to: '2026-11-30' });
    expect(monthWindow(12, new Date(2026, 1, 3))).toEqual({ from: '2025-03-01', to: '2026-02-28' });
  });
});
