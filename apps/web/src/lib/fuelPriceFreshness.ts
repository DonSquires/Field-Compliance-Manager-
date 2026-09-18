export type FuelMedianReadiness = 'missing' | 'thin' | 'stale' | 'ready';

export interface FuelMedianStatus {
  state: FuelMedianReadiness;
  message: string;
}

function daysSince(date: string, today: Date): number {
  const observed = new Date(`${date}T00:00:00Z`).getTime();
  return Math.floor((Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) - observed) / 86_400_000);
}

export function fuelMedianStatus(observationCount: number, latestObservedOn: string | null | undefined, today = new Date()): FuelMedianStatus {
  if (!latestObservedOn || observationCount === 0) {
    return { state: 'missing', message: 'No cited website prices yet. Record at least three recent prices before relying on this travel-cost input.' };
  }
  const age = daysSince(latestObservedOn, today);
  if (age > 21) {
    return { state: 'stale', message: `Latest cited price is ${age} days old. Check the website and record a newer price before relying on this input.` };
  }
  if (observationCount < 3) {
    return { state: 'thin', message: `${observationCount} cited price${observationCount === 1 ? '' : 's'} in the three-month window. Add at least ${3 - observationCount} more for a steadier median.` };
  }
  return { state: 'ready', message: `${observationCount} cited prices in the three-month window. Latest price is ${age === 0 ? 'today' : `${age} day${age === 1 ? '' : 's'} old`}.` };
}
