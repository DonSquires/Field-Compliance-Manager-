import { describe, expect, it } from 'vitest';
import { fuelCostPerKm, suggestedVehicleVariableCost } from './fuelCosting';

describe('fuel costing', () => {
  it('calculates fuel-only cost per kilometre from a cited median and consumption', () => {
    expect(fuelCostPerKm(2.399, 8.5)).toBe(0.2039);
    expect(fuelCostPerKm(null, 8.5)).toBeNull();
    expect(fuelCostPerKm(2.399, 0)).toBeNull();
  });

  it('adds declared running cost without changing a customer charge', () => {
    expect(suggestedVehicleVariableCost(0.2039, 0.15)).toBe(0.3539);
    expect(suggestedVehicleVariableCost(null, 0.15)).toBeNull();
  });
});
