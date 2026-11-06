import { describe, expect, it } from 'vitest';
import { readServiceDelivery, readServiceDeliveryOverview } from './reportServiceDelivery';

export const clientSummary = {
  version: 1,
  counts: {
    reviewedReports: { recorded: 2, alreadyInActivity: 1, additional: 1 },
    completedDispatch: { recorded: 1, alreadyInActivity: 0, additional: 1 },
    completedStatic: { recorded: 1, alreadyInActivity: 0, additional: 1 },
  },
};

describe('safe service evidence projection', () => {
  it('accepts only reconciled counts and ignores private or future fields', () => {
    const result = readServiceDelivery({ ...clientSummary, notes: 'PRIVATE', counts: { ...clientSummary.counts, private: 'PRIVATE' } });
    expect(result).toHaveLength(3);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(result?.[0]).toEqual({ kind: 'reviewedReports', recorded: 2, alreadyInActivity: 1, additional: 1 });
  });
  it('does not turn absent, malformed or inconsistent counts into zero', () => {
    for (const value of [null, {}, { ...clientSummary, version: 2 }, { version: 1, counts: {} },
      { ...clientSummary, counts: { ...clientSummary.counts, completedDispatch: { recorded: 1, alreadyInActivity: 1, additional: 1 } } }]) {
      expect(readServiceDelivery(value)).toBeNull();
    }
  });
  it('aggregates only explicit provider counts', () => {
    const row = { client: clientSummary, internal: { awaitingReview: 2, handoversReceived: 1, notes: 'PRIVATE' } };
    const result = readServiceDeliveryOverview([row, row]);
    expect(result?.counts[0].recorded).toBe(4);
    expect(result?.awaitingReview).toBe(4);
    expect(result?.handoversReceived).toBe(2);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(readServiceDeliveryOverview([])).toBeNull();
    expect(readServiceDeliveryOverview([{ client: clientSummary }])).toBeNull();
  });
});
