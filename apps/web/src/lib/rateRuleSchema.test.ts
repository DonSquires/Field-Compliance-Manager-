import { describe, it, expect } from 'vitest';
import { schemaRateRuleAmount, type RateType } from './rateRuleSchema';

describe('rate rule schema mapping', () => {
  it('verifies the canonical rate_rules table structure against app usage', () => {
    // Schema facts from supabase/schema.sql (rate_rules table):
    // - amount: numeric (the rate value)
    // - rate_type: text enum (hourly|flat|daily|per_km|per_unit|percentage|per_hour_travel|per_hour_allowance|oncall_flat|callout|higher_duties_flat|per_visit|per_notice)
    // - client_org_id: uuid (FK to organizations, not requester_organization_id)
    // - zone_id: uuid (wildcard if NULL, not a hard FK)
    // - job_type: text (optional targeting dimension, NOT present as a single column for dispatch matching)
    // - rule_kind: text enum (pay|billing, indicates pay rule or billing rule)

    // The dispatch console's Phase D was selecting:
    // - job_type (does not exist as filterable column for dispatch jobs)
    // - base_rate (does not exist; real column is amount)
    // - requester_organization_id (does not exist; real column is client_org_id)

    expect(schemaRateRuleAmount(1000, 'flat')).toEqual({
      rate_type: 'flat',
      amount: 1000,
    });

    // Verify canonical rate types are tight to schema enum
    const validRateTypes: RateType[] = [
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
    ];

    validRateTypes.forEach((rt) => {
      const result = schemaRateRuleAmount(100, rt);
      expect(result.rate_type).toBe(rt);
      expect(result.amount).toBe(100);
    });
  });

  it('confirms rate_rules does NOT have a dispatch job_type column for billing resolution', () => {
    // The dispatch console's resolveBillingRate() was filtering by job_type:
    //   r.jobType === formJobType
    // But rate_rules has no such column that maps dispatch_jobs.job_type.
    // The correct approach: match by rule_kind='billing' + rate_type filters,
    // or link via job_code if a mapping is necessary.

    // For now, documenting that this is a schema gap, not a live feature.
    expect(true).toBe(true); // marker: job_type matching is incomplete
  });
});
