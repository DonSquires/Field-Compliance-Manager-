const COST_FIELDS = new Set(['job_cost', 'travel_cost', 'total_cost']);

export function hasSourceFinancialValues(value) {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) =>
    (COST_FIELDS.has(key) && child !== null && child !== undefined)
    || hasSourceFinancialValues(child));
}
