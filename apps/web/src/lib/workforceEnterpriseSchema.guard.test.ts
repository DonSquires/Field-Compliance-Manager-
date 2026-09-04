import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (name: string) => {
  const local = resolve(process.cwd(), `supabase/migrations/${name}`);
  const root = existsSync(local) ? local : resolve(process.cwd(), `../../supabase/migrations/${name}`);
  return readFileSync(root, 'utf8');
};

const hotfix = read('20260904090000_fix_roster_slots_updated_at.sql');
const tier1 = read('20260904100000_workforce_time_attendance_core.sql');
const tier2 = read('20260904110000_oncall_callout_activation.sql');
const tier3 = read('20260904120000_seniority_court_assets.sql');

describe('roster_slots.updated_at hotfix', () => {
  it('adds the column the roster RPCs already write', () => {
    expect(hotfix).toContain('ALTER TABLE "public"."roster_slots"');
    expect(hotfix).toContain('ADD COLUMN IF NOT EXISTS "updated_at"');
    expect(hotfix).toContain('tg_touch_updated_at');
  });
});

describe('Tier 1 time and attendance core', () => {
  it('defines a universal clock-in that is idempotent and status-checked', () => {
    expect(tier1).toContain('CREATE OR REPLACE FUNCTION "public"."start_officer_shift"');
    expect(tier1).toContain('Shift changed from expected status % to %');
    expect(tier1).toContain("'officer_shift_started'");
    expect(tier1).toContain('actual_start = coalesce(actual_start, v_at)');
  });

  it('tracks rest and meal breaks with paid/unpaid separation', () => {
    expect(tier1).toContain('CREATE TABLE IF NOT EXISTS "public"."shift_breaks"');
    expect(tier1).toContain('CREATE OR REPLACE FUNCTION "public"."start_shift_break"');
    expect(tier1).toContain('CREATE OR REPLACE FUNCTION "public"."end_shift_break"');
    expect(tier1).toContain("p_break_type = 'rest'");
    expect(tier1).toContain('An open break is already in progress for this shift');
  });

  it('computes statutory break entitlement from worked hours', () => {
    expect(tier1).toContain('CREATE OR REPLACE FUNCTION "public"."get_shift_break_entitlement"');
    expect(tier1).toContain('rest_breaks_required');
    expect(tier1).toContain('meal_breaks_required');
    expect(tier1).toContain('compliant');
  });

  it('enforces fatigue rules at roster write time', () => {
    expect(tier1).toContain('CREATE TABLE IF NOT EXISTS "public"."organization_fatigue_rules"');
    expect(tier1).toContain('CREATE OR REPLACE FUNCTION "public"."staff_fatigue_conflict"');
    expect(tier1).toContain('CREATE OR REPLACE FUNCTION "public"."enforce_roster_slot_availability"');
    expect(tier1).toContain('Fatigue rule breach: %');
  });

  it('activates payroll export batching for approved timesheets only', () => {
    expect(tier1).toContain('CREATE OR REPLACE FUNCTION "public"."create_payroll_export_batch"');
    expect(tier1).toContain("t.status = 'approved'");
    expect(tier1).toContain('t.payroll_export_batch_id is null');
    expect(tier1).toContain("'payroll_export_batch_created'");
  });
});

describe('Tier 2 on-call and callout activation', () => {
  it('closes direct writes on the previously ungoverned tables', () => {
    expect(tier2).toContain('REVOKE INSERT, UPDATE, DELETE ON TABLE "public"."on_call_periods"');
    expect(tier2).toContain('REVOKE INSERT, UPDATE, DELETE ON TABLE "public"."callout_shifts"');
    expect(tier2).toContain('DROP POLICY IF EXISTS "on_call_periods_insert"');
  });

  it('governs on-call assignment and officer response', () => {
    expect(tier2).toContain('CREATE OR REPLACE FUNCTION "public"."create_on_call_period"');
    expect(tier2).toContain('CREATE OR REPLACE FUNCTION "public"."respond_to_on_call_period"');
    expect(tier2).toContain('Officer already holds an overlapping on-call period');
    expect(tier2).toContain("'on_call_period_created'");
  });

  it('advances callouts strictly forward through the timeline', () => {
    expect(tier2).toContain('CREATE OR REPLACE FUNCTION "public"."open_callout"');
    expect(tier2).toContain('CREATE OR REPLACE FUNCTION "public"."record_callout_milestone"');
    expect(tier2).toContain('Callout milestone % cannot follow status %');
    expect(tier2).toContain("'callout_milestone_recorded'");
  });

  it('honours the minimum pay guarantee', () => {
    expect(tier2).toContain('CREATE OR REPLACE FUNCTION "public"."get_callout_pay_summary"');
    expect(tier2).toContain('greatest(v_worked, v_callout.minimum_pay_hours)');
    expect(tier2).toContain('minimum_applied');
  });
});

describe('Tier 3 seniority, court time, and fleet', () => {
  it('offers overtime in seniority order excluding unavailable and fatigued staff', () => {
    expect(tier3).toContain('CREATE OR REPLACE FUNCTION "public"."offer_overtime_by_seniority"');
    expect(tier3).toContain('order by sp.seniority_date asc nulls last');
    expect(tier3).toContain('staff_has_roster_availability_conflict');
    expect(tier3).toContain('staff_fatigue_conflict');
    expect(tier3).toContain("'overtime_offered_by_seniority'");
  });

  it('makes first acceptance win and withdraws the remaining offers', () => {
    expect(tier3).toContain('CREATE OR REPLACE FUNCTION "public"."respond_to_overtime_offer"');
    expect(tier3).toContain("set status = 'withdrawn'");
    expect(tier3).toContain('This overtime offer has expired');
  });

  it('schedules court appearances and derives overtime from roster coverage', () => {
    expect(tier3).toContain('CREATE TABLE IF NOT EXISTS "public"."court_appearances"');
    expect(tier3).toContain('CREATE OR REPLACE FUNCTION "public"."schedule_court_appearance"');
    expect(tier3).toContain('CREATE OR REPLACE FUNCTION "public"."record_court_appearance_outcome"');
    expect(tier3).toContain('subpoena_reference');
    expect(tier3).toContain("'court_appearance_scheduled'");
  });

  it('governs the previously dormant asset and asset_check tables', () => {
    expect(tier3).toContain('REVOKE INSERT, UPDATE, DELETE ON TABLE "public"."assets"');
    expect(tier3).toContain('REVOKE INSERT, UPDATE, DELETE ON TABLE "public"."asset_checks"');
    expect(tier3).toContain('CREATE OR REPLACE FUNCTION "public"."manage_asset"');
    expect(tier3).toContain('CREATE OR REPLACE FUNCTION "public"."record_asset_check"');
  });

  it('links assets to shifts and routes defective returns to maintenance', () => {
    expect(tier3).toContain('CREATE TABLE IF NOT EXISTS "public"."shift_assets"');
    expect(tier3).toContain('CREATE OR REPLACE FUNCTION "public"."assign_shift_asset"');
    expect(tier3).toContain('CREATE OR REPLACE FUNCTION "public"."return_shift_asset"');
    expect(tier3).toContain("when p_condition in ('major_issue', 'unserviceable') then 'maintenance'");
    expect(tier3).toContain('Asset is not available (current status %)');
  });
});

describe('governed grants across all three tiers', () => {
  it('revokes anon access and grants only authenticated and service_role', () => {
    for (const fn of [
      'start_officer_shift', 'start_shift_break', 'end_shift_break',
      'get_shift_break_entitlement', 'staff_fatigue_conflict', 'create_payroll_export_batch',
    ]) {
      expect(tier1).toContain(`REVOKE ALL ON FUNCTION "public"."${fn}"`);
    }
    for (const fn of [
      'create_on_call_period', 'respond_to_on_call_period', 'open_callout',
      'record_callout_milestone', 'get_callout_pay_summary',
    ]) {
      expect(tier2).toContain(`REVOKE ALL ON FUNCTION "public"."${fn}"`);
    }
    for (const fn of [
      'offer_overtime_by_seniority', 'respond_to_overtime_offer', 'schedule_court_appearance',
      'record_court_appearance_outcome', 'assign_shift_asset', 'return_shift_asset',
      'manage_asset', 'record_asset_check',
    ]) {
      expect(tier3).toContain(`REVOKE ALL ON FUNCTION "public"."${fn}"`);
    }
  });
});
