export interface DispatchBillingRule {
  id: string;
  amount: number;
  rateType: string;
  clientOrgId: string | null;
  siteId: string | null;
  zoneId: string | null;
  jobType: string | null;
  priority: number;
  effectiveFrom: string | null;
  effectiveTo: string | null;
}

export function resolveDispatchBillingRule(
  rules: DispatchBillingRule[],
  context: { clientOrgId: string; siteId: string; zoneId?: string | null; jobType: string; onDate?: string },
): DispatchBillingRule | null {
  const onDate = context.onDate ?? new Date().toISOString().slice(0, 10);

  return rules
    .filter((rule) =>
      (!rule.clientOrgId || rule.clientOrgId === context.clientOrgId) &&
      (!rule.siteId || rule.siteId === context.siteId) &&
      (!rule.zoneId || rule.zoneId === context.zoneId) &&
      (!rule.jobType || rule.jobType === context.jobType) &&
      (!rule.effectiveFrom || rule.effectiveFrom <= onDate) &&
      (!rule.effectiveTo || rule.effectiveTo >= onDate),
    )
    .sort((left, right) => {
      const specificity = (rule: DispatchBillingRule) =>
        Number(Boolean(rule.clientOrgId)) + Number(Boolean(rule.siteId)) * 2 + Number(Boolean(rule.zoneId)) * 2 + Number(Boolean(rule.jobType));
      return specificity(right) - specificity(left) || right.priority - left.priority;
    })[0] ?? null;
}