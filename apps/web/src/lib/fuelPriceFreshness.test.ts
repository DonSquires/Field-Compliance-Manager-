import { describe, expect, it } from 'vitest';
import { fuelMedianStatus } from './fuelPriceFreshness';

const today = new Date('2026-09-18T12:00:00Z');

describe('fuel median freshness', () => {
  it('asks for evidence when no median input exists', () => {
    expect(fuelMedianStatus(0, null, today)).toEqual({ state: 'missing', message: 'No cited website prices yet. Record at least three recent prices before relying on this travel-cost input.' });
  });

  it('does not treat a thin or stale data set as ready', () => {
    expect(fuelMedianStatus(2, '2026-09-17', today).state).toBe('thin');
    expect(fuelMedianStatus(8, '2026-08-01', today).state).toBe('stale');
  });

  it('accepts three recent cited prices', () => {
    expect(fuelMedianStatus(3, '2026-09-18', today)).toEqual({ state: 'ready', message: '3 cited prices in the three-month window. Latest price is today.' });
  });
});
