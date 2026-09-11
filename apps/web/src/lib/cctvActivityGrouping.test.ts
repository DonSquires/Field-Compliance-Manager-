import { describe, expect, it } from 'vitest';
import { groupCCTVActivity, type CCTVActivityObservation } from './cctvActivityGrouping';

const base: CCTVActivityObservation = {
  id: 'event-1',
  kind: 'person',
  observedAt: '2026-08-01T08:00:00Z',
  reviewState: 'unreviewed',
  zoneLabel: 'North gate',
};

describe('groupCCTVActivity', () => {
  it('groups canonical reviewed links across weeks ahead of model similarity', () => {
    const groups = groupCCTVActivity([
      { ...base, id: 'one', canonicalId: 'person-a', observedAt: '2026-08-01T08:00:00Z', embedding: [1, 0] },
      { ...base, id: 'two', canonicalId: 'person-a', observedAt: '2026-08-15T09:00:00Z', embedding: [0, 1] },
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ authority: 'canonical_reviewed', observationCount: 2, visitDates: ['2026-08-01', '2026-08-15'] });
    expect(groups[0].blurb).toContain('across 2 separate dates');
  });

  it('groups similar people and animals provisionally without asserting identity', () => {
    const groups = groupCCTVActivity([
      { ...base, id: 'person-1', embedding: [1, 0, 0] },
      { ...base, id: 'person-2', observedAt: '2026-08-08T08:00:00Z', embedding: [0.99, 0.01, 0] },
      { ...base, id: 'animal-1', kind: 'animal', animalType: 'dog', embedding: [0, 1, 0] },
      { ...base, id: 'animal-2', kind: 'animal', animalType: 'dog', observedAt: '2026-08-12T10:00:00Z', embedding: [0, 0.99, 0.01] },
    ]);

    expect(groups).toHaveLength(2);
    expect(groups.every((group) => group.authority === 'provisional_similarity')).toBe(true);
    expect(groups.every((group) => group.blurb.includes('requiring human confirmation'))).toBe(true);
  });

  it('groups reliable normalized vehicle plates across observation dates', () => {
    const groups = groupCCTVActivity([
      { ...base, id: 'vehicle-1', kind: 'vehicle', plate: 'ABC-123', observedAt: '2026-08-02T08:00:00Z' },
      { ...base, id: 'vehicle-2', kind: 'vehicle', plate: 'ABC123', observedAt: '2026-08-19T08:00:00Z' },
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ kind: 'vehicle', label: 'ABC123', observationCount: 2 });
    expect(groups[0].authority).toBe('provisional_similarity');
  });
});
