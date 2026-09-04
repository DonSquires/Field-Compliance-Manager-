import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const local = resolve(process.cwd(), 'supabase/migrations/20260904140000_rate_resolution_engine.sql');
const sql = readFileSync(
  existsSync(local) ? local : resolve(process.cwd(), '../../supabase/migrations/20260904140000_rate_resolution_engine.sql'),
  'utf8',
);

describe('rate resolution engine', () => {
  it('replaces the lost computeTravelDistanceKm with a null-safe haversine', () => {
    expect(sql).toContain('CREATE OR REPLACE FUNCTION "public"."compute_travel_distance_km"');
    expect(sql).toContain('6371.0088');
    // An unavailable coordinate must not read as a zero-distance trip.
    expect(sql).toContain('p_from_lat is null or p_from_lng is null or p_to_lat is null or p_to_lng is null then null');
  });

  it('resolves the most specific effective-dated active rule', () => {
    expect(sql).toContain('CREATE OR REPLACE FUNCTION "public"."resolve_rate_rule"');
    expect(sql).toContain('r.active = true');
    expect(sql).toContain('r.effective_from is null or r.effective_from <= v_when');
    expect(sql).toContain('r.effective_to is null or r.effective_to >= v_when');
    expect(sql).toContain('order by specificity desc, r.priority desc');
  });

  it('treats a null rule dimension as a wildcard rather than a mismatch', () => {
    expect(sql).toContain('r.site_id is null or r.site_id = p_site_id');
    expect(sql).toContain('r.client_org_id is null or r.client_org_id = p_client_org_id');
    expect(sql).toContain('r.day_category is null or r.day_category = v_day');
  });

  it('bands travel rates on real distance only', () => {
    expect(sql).toContain('r.distance_min_km is null or (p_distance_km is not null and p_distance_km >= r.distance_min_km)');
    expect(sql).toContain('r.distance_max_km is null or (p_distance_km is not null and p_distance_km <= r.distance_max_km)');
  });

  it('writes pay lines only for completed jobs and stays idempotent', () => {
    expect(sql).toContain('CREATE OR REPLACE FUNCTION "public"."resolve_dispatch_job_pay_lines"');
    expect(sql).toContain("v_job.status <> 'completed' or v_job.completed_at is null");
    expect(sql).toContain('if exists (select 1 from public.dispatch_job_pay_lines l where l.source_dispatch_id = v_job.id)');
    expect(sql).toContain("'dispatch_pay_lines_resolved'");
  });

  it('never produces a silent zero pay line', () => {
    expect(sql).toContain("'UNRESOLVED'");
    expect(sql).toContain('Unresolved: no active hourly pay rule matched');
    expect(sql).toContain('Unresolved: no on-scene or en-route timestamp');
    expect(sql).toContain('no_dispatch_origin_coordinate');
    expect(sql).toContain('site_has_no_coordinate');
  });

  it('forecasts labour cost and margin with an explicit unpriced status', () => {
    expect(sql).toContain('CREATE OR REPLACE FUNCTION "public"."get_roster_labour_cost"');
    expect(sql).toContain("'no_pay_rule'");
    expect(sql).toContain("'no_billing_rule'");
    expect(sql).toContain("'resolved'");
  });

  it('keeps every new function off anon and revoked by default', () => {
    for (const fn of [
      'compute_travel_distance_km', 'resolve_rate_rule',
      'resolve_dispatch_job_pay_lines', 'get_roster_labour_cost',
    ]) {
      expect(sql).toContain(`REVOKE ALL ON FUNCTION "public"."${fn}"`);
    }
  });

  it('does not mutate the high-blast-radius commercial tables', () => {
    for (const table of ['quotes', 'invoices', 'client_sites', 'service_agreement_locations', 'shifts']) {
      expect(sql).not.toMatch(new RegExp(`(insert into|update)\\s+public\\.${table}\\b`, 'i'));
    }
  });
});
