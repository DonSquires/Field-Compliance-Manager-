import { expect, it } from 'vitest';
import { fromNzDateInput, nzDateInput } from './nzDateTime';

it('round trips NZ summer and winter shift instants independently of browser timezone', () => {
  expect(nzDateInput('2026-11-10T19:00:00Z')).toBe('2026-11-11T08:00');
  expect(fromNzDateInput('2026-11-11T08:00')).toBe('2026-11-10T19:00:00.000Z');
  expect(fromNzDateInput('2020-06-01T09:00')).toBe('2020-05-31T21:00:00.000Z');
});

it('preserves the original offset and seconds when an ambiguous recorded time is unchanged', () => {
  expect(fromNzDateInput('2026-04-05T02:30', '2026-04-04T13:30:17Z')).toBe('2026-04-04T13:30:17.000Z');
  expect(fromNzDateInput('2026-04-05T02:30', '2026-04-04T14:30:17Z')).toBe('2026-04-04T14:30:17.000Z');
  expect(() => fromNzDateInput('2026-04-05T02:30')).toThrow(/occurs twice/i);
});

it('rejects nonexistent DST and invalid calendar times instead of silently shifting payable hours', () => {
  expect(() => fromNzDateInput('2026-09-27T02:30')).toThrow(/does not exist/i);
  expect(() => fromNzDateInput('2026-02-31T09:00')).toThrow(/does not exist|invalid/i);
  expect(fromNzDateInput('')).toBeNull();
});
