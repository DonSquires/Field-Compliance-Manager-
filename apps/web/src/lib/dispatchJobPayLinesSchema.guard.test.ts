import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260901003000_resolve_dispatch_job_pay_lines.sql'), 'utf8');

describe('dispatch job pay line resolution', () => {
  it('is wired into completion and never blocks the transition on failure', () => {
    expect(migration).toContain("if p_next_status = 'completed' then");
    expect(migration).toContain('perform public.resolve_dispatch_job_pay_lines(p_job_id)');
    expect(migration).toContain('exception when others then');
    expect(migration).toContain("raise warning 'resolve_dispatch_job_pay_lines failed for job %: %'");
  });

  it('matches the single highest-priority active pay rule with wildcard-null targeting columns', () => {
    expect(migration).toContain("r.rule_kind = 'pay'");
    expect(migration).toContain('and r.active');
    expect(migration).toContain('r.service_type is null or r.service_type = v_resource.service_type');
    expect(migration).toContain('r.job_type is null or r.job_type = v_job.job_type');
    expect(migration).toContain('order by r.priority desc, r.created_at desc');
  });

  it('computes quantity per rate_type and leaves percentage/per_unit unresolved rather than guessed', () => {
    expect(migration).toContain("when 'hourly', 'per_hour_allowance' then");
    expect(migration).toContain("when 'per_hour_travel' then");
    expect(migration).toContain("when 'flat', 'daily', 'oncall_flat', 'callout', 'higher_duties_flat', 'per_visit', 'per_notice' then");
    expect(migration).toContain("when 'per_km' then");
    expect(migration).toContain('else');
    expect(migration).toContain('v_quantity := null;');
    expect(migration).toContain('if v_quantity is null then\n      continue;');
  });

  it('sources per_km distance from the officer last-known GPS position and the client site', () => {
    expect(migration).toContain('from public.officer_gps_log og');
    expect(migration).toContain('og.created_at <= coalesce(v_job.dispatched_at, v_job.created_at)');
    expect(migration).toContain('from public.client_sites cs');
    expect(migration).toContain('public.compute_point_distance_km(v_officer_lat, v_officer_lng, v_site_lat, v_site_lng)');
  });

  it('upserts idempotently against both partial unique indexes on dispatch_job_pay_lines', () => {
    expect(migration).toContain('on conflict (organization_id, source_dispatch_id, pay_code) where pay_code is not null');
    expect(migration).toContain('on conflict (organization_id, source_dispatch_id) where pay_code is null');
  });

  it('is internal-only: not directly executable by authenticated or anon callers', () => {
    expect(migration).toContain('revoke all on function public.resolve_dispatch_job_pay_lines(uuid) from public, anon, authenticated');
    expect(migration).toContain('grant execute on function public.resolve_dispatch_job_pay_lines(uuid) to service_role');
  });
});
