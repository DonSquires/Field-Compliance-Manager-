export const SERVICE_DELIVERY_LABELS = {
  reviewedReports: 'Reviewed officer incident and site hazard reports',
  completedDispatch: 'Completed dispatch jobs',
  completedStatic: 'Completed static attendances',
} as const;

export interface ServiceDeliveryCount {
  kind: keyof typeof SERVICE_DELIVERY_LABELS;
  recorded: number;
  alreadyInActivity: number;
  additional: number;
}

const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export function readServiceDelivery(value: unknown): ServiceDeliveryCount[] | null {
  const summary = object(value);
  const counts = object(summary?.counts);
  if (summary?.version !== 1 || !counts) return null;
  const result: ServiceDeliveryCount[] = [];
  for (const kind of Object.keys(SERVICE_DELIVERY_LABELS) as Array<keyof typeof SERVICE_DELIVERY_LABELS>) {
    const row = object(counts[kind]);
    if (!row || !isCount(row.recorded) || !isCount(row.alreadyInActivity) || !isCount(row.additional)
      || row.recorded !== row.alreadyInActivity + row.additional) return null;
    result.push({ kind, recorded: row.recorded, alreadyInActivity: row.alreadyInActivity, additional: row.additional });
  }
  return result;
}

export function readServiceDeliveryOverview(value: unknown): {
  counts: ServiceDeliveryCount[]; awaitingReview: number; handoversReceived: number;
} | null {
  if (!Array.isArray(value) || !value.length) return null;
  let counts: ServiceDeliveryCount[] | null = null;
  let awaitingReview = 0;
  let handoversReceived = 0;
  for (const item of value) {
    const row = object(item);
    const next = readServiceDelivery(row?.client);
    const internal = object(row?.internal);
    if (!next || !internal || !isCount(internal.awaitingReview) || !isCount(internal.handoversReceived)) return null;
    counts = counts ? counts.map((count, index) => ({
      kind: count.kind,
      recorded: count.recorded + next[index].recorded,
      alreadyInActivity: count.alreadyInActivity + next[index].alreadyInActivity,
      additional: count.additional + next[index].additional,
    })) : next;
    awaitingReview += internal.awaitingReview;
    handoversReceived += internal.handoversReceived;
  }
  return counts ? { counts, awaitingReview, handoversReceived } : null;
}
