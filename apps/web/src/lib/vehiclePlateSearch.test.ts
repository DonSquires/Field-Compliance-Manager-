import { describe, expect, it } from 'vitest';
import { vehiclePlateSearchPattern } from './vehiclePlateSearch';

describe('registration search patterns', () => {
  it.each([
    ['RJ%9%8', 'RJ%9%8'],
    ['%yg%%4', '%YG%4'],
    ['yg4', '%YG4%'],
    ['  ab-c 123 ', '%ABC123%'],
    ['%9%', '%9%'],
    ['9%', '9%'],
  ])('preserves the requested pattern %s', (input, expected) => {
    expect(vehiclePlateSearchPattern(input)).toBe(expected);
  });

  it.each(['', '%%', '_', 'ABC_123', 'ABC*', 'A,(B)', 'A\\B'])('rejects invalid or unbounded input %s', (input) => {
    expect(() => vehiclePlateSearchPattern(input)).toThrow('Enter part of a registration');
  });
});
