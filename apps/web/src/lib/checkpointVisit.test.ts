import { describe, expect, it } from 'vitest';
import { countCompletedCheckpoints } from './checkpointVisit';

describe('countCompletedCheckpoints', () => {
  it('counts completed checkpoints by unique checkpoint instead of raw visit rows', () => {
    expect(
      countCompletedCheckpoints([
        { checkpoint_id: 'a' },
        { checkpoint_id: 'a' },
        { checkpoint_id: 'b' },
      ])
    ).toBe(2);
  });

  it('counts route checkpoint visits, which carry route_checkpoint_id instead of checkpoint_id', () => {
    expect(
      countCompletedCheckpoints([
        { checkpoint_id: null, route_checkpoint_id: 'r1' },
        { checkpoint_id: null, route_checkpoint_id: 'r1' },
        { checkpoint_id: null, route_checkpoint_id: 'r2' },
      ])
    ).toBe(2);
  });

  it('ignores visit rows that reference no checkpoint at all', () => {
    expect(countCompletedCheckpoints([{ checkpoint_id: null, route_checkpoint_id: null }, {}])).toBe(0);
  });
});
