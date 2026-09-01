import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260901022000_oncall_callout_travel_allowance.sql'), 'utf8');
const schema = readFileSync(resolve(process.cwd(), '../../supabase/schema.sql'), 'utf8');

describe('respond_to_on_call_period / log_callout_milestone / submit_travel_allowance schema', () => {
  it('only lets the assigned officer respond to their own pending on-call period', () => {
    expect(migration).toContain('v_period.officer_user_id <> v_user_id');
    expect(migration).toContain("v_period.status <> 'pending'");
    expect(migration).toContain("if p_decision not in ('accepted', 'declined')");
  });

  it('creates the callout_shift on the first received milestone and updates it thereafter', () => {
    expect(migration).toContain("if p_milestone <> 'received' then raise exception 'The first logged milestone for a callout must be received'");
    expect(migration).toContain('insert into callout_shifts (organization_id, on_call_period_id, officer_user_id, callout_received_at)');
    expect(migration).toContain("if p_milestone = 'returned' then");
    expect(migration).toContain("update on_call_periods set status = 'completed'");
  });

  it('authorises travel allowance submission to the callout officer or an org admin', () => {
    expect(migration).toContain('v_callout.officer_user_id <> v_user_id and not is_admin_for_org(v_callout.organization_id)');
  });

  it('leaves reimbursement rates for payroll to assign since no rate configuration exists', () => {
    expect(migration).toContain('Reimbursement rates (rate_per_km, time_rate) are intentionally left null');
  });

  it('is granted to authenticated callers and present in the generated schema dump', () => {
    expect(migration).toContain('grant execute on function public.respond_to_on_call_period');
    expect(migration).toContain('grant execute on function public.log_callout_milestone');
    expect(migration).toContain('grant execute on function public.submit_travel_allowance');
    expect(schema).toContain('CREATE OR REPLACE FUNCTION "public"."respond_to_on_call_period"');
    expect(schema).toContain('CREATE OR REPLACE FUNCTION "public"."log_callout_milestone"');
    expect(schema).toContain('CREATE OR REPLACE FUNCTION "public"."submit_travel_allowance"');
  });
});
