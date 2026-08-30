import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260830135000_roster_commercial_readiness.sql'), 'utf8');
const schema = readFileSync(resolve(process.cwd(), '../../supabase/schema.sql'), 'utf8');

describe('roster commercial readiness', () => {
  it('reports pay readiness without returning wage values', () => {
    expect(sql).toContain("r.rule_kind='pay'");
    expect(sql).toContain("then 'ready' else 'missing_rule'");
    expect(sql).not.toMatch(/returns table\([^)]*(amount|rate)/);
  });

  it('keeps static contract billing and accepted quote provenance distinct', () => {
    expect(sql).toContain("u.work_unit_type='static'");
    expect(sql).toContain('public.roster_agreement_billing_ready');
    expect(sql).toContain("q.status='accepted'");
    expect(sql).toContain("then 'missing_contract'");
  });

  it('evaluates patrol billing at required stop-module grain', () => {
    expect(sql).toContain('public.shift_stop_modules');
    expect(sql).toContain('sm.is_required');
    expect(sql).toContain('sm.service_agreement_location_id is null');
    expect(sql).toContain("then 'missing_attribution'");
  });

  it('reports geofence verification and internal cost-centre coding separately', () => {
    expect(sql).toContain('public.geofence_boundary_history');
    expect(sql).toContain("return 'missing'");
    expect(sql).toContain("then 'verified'");
    expect(sql).toContain("u.cost_centre_id is not null then 'ready'");
    expect(schema).toContain('CREATE FUNCTION "public"."get_roster_commercial_readiness"');
    expect(sql).toContain('from public,anon,authenticated');
  });
});