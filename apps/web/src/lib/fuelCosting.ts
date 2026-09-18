export function fuelCostPerKm(medianPricePerLitre: number | null | undefined, litresPer100Km: number | null | undefined): number | null {
  if (!(medianPricePerLitre && medianPricePerLitre > 0) || !(litresPer100Km && litresPer100Km > 0)) return null;
  return Math.round((medianPricePerLitre * litresPer100Km / 100) * 10000) / 10000;
}

export function suggestedVehicleVariableCost(fuelOnlyPerKm: number | null, runningCostPerKm: number | null | undefined): number | null {
  if (fuelOnlyPerKm === null) return null;
  return Math.round((fuelOnlyPerKm + Math.max(0, runningCostPerKm ?? 0)) * 10000) / 10000;
}
