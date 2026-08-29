import { describe, expect, it } from 'vitest';
import { shiftStopStatusLabel } from './shiftStopStatus';

describe('shift stop status labels', () => {
  it('uses the canonical shift_stops lifecycle labels', () => {
    expect(shiftStopStatusLabel('pending')).toBe('Pending');
    expect(shiftStopStatusLabel('en_route')).toBe('En Route');
    expect(shiftStopStatusLabel('on_scene')).toBe('On Scene');
    expect(shiftStopStatusLabel('completed')).toBe('Completed');
    expect(shiftStopStatusLabel('skipped')).toBe('Skipped');
    expect(shiftStopStatusLabel('cancelled')).toBe('Cancelled');
  });
});
