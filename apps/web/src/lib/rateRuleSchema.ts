/**
 * Rate rule schema mapping.
 *
 * Canonical rate_rules table structure from supabase/schema.sql:
 * - amount: numeric (the actual rate value)
 * - rate_type: text enum (hourly|flat|daily|per_km|per_unit|percentage|per_hour_travel|per_hour_allowance|oncall_flat|callout|higher_duties_flat|per_visit|per_notice)
 * - rule_kind: text enum (pay|billing)
 * - client_org_id: uuid (organization the rate applies to; NULL = wildcard)
 * - zone_id: uuid (optional zone targeting; NULL = wildcard)
 * - job_type: text (generic targeting dimension, but NOT the dispatch_jobs.job_type enum)
 * - job_code: text (pay/billing code system identifier)
 *
 * Dispatch console issue (Phase D): was selecting non-existent columns
 * - base_rate (doesn't exist; real column is amount)
 * - requester_organization_id (doesn't exist; real column is client_org_id)
 * - job_type was being used as dispatch job filtering (schema doesn't support this link)
 */

export type RateType =
  | 'hourly'
  | 'flat'
  | 'daily'
  | 'per_km'
  | 'per_unit'
  | 'percentage'
  | 'per_hour_travel'
  | 'per_hour_allowance'
  | 'oncall_flat'
  | 'callout'
  | 'higher_duties_flat'
  | 'per_visit'
  | 'per_notice';

export type RuleKind = 'pay' | 'billing';

export interface RateRule {
  rate_type: RateType;
  amount: number;
}

/**
 * Validate and return canonical rate rule amount with rate type.
 * Rate rules in rate_rules table always have an amount (numeric) and rate_type.
 */
export function schemaRateRuleAmount(amount: number, rateType: string): RateRule {
  const validRateTypes: Set<string> = new Set([
    'hourly',
    'flat',
    'daily',
    'per_km',
    'per_unit',
    'percentage',
    'per_hour_travel',
    'per_hour_allowance',
    'oncall_flat',
    'callout',
    'higher_duties_flat',
    'per_visit',
    'per_notice',
  ]);

  if (!validRateTypes.has(rateType)) {
    console.warn(
      `[rateRuleSchema] Invalid rate_type "${rateType}", using fallback "flat"`,
    );
    return { rate_type: 'flat', amount };
  }

  return { rate_type: rateType as RateType, amount };
}
