import { describe, expect, it } from 'vitest';
import { isWriteOrDestructiveAction } from './humanTestActionPolicy';

describe('human test action safety policy', () => {
  it.each([
    'Generate report drafts',
    'Work out tax to set aside',
    'Compare price to cost',
    'Start import',
    'Promote evidence record',
    'Post approved labour cost',
    'Acknowledge alert',
    'Accept person identity',
    'Not a vehicle',
    'Return for correction',
    'End shift',
  ])('skips possible writes: %s', (label) => {
    expect(isWriteOrDestructiveAction(label)).toBe(true);
  });

  it.each([
    'Refresh operations overview',
    'Open field operations',
    'Search observations',
    'Choose a service agreement',
    'Compare values in the read-only preview',
  ])('allows navigation and non-mutating controls: %s', (label) => {
    expect(isWriteOrDestructiveAction(label)).toBe(false);
  });
});