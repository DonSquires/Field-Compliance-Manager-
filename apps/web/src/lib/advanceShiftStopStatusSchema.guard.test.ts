import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260901012000_advance_shift_stop_status.sql'), 'utf8');
const schema = readFileSync(resolve(process.cwd(), '../../supabase/schema.sql'), 'utf8');

describe('advance_shift_stop_status schema', () => {
  it('locks the stop and authorises only org admins or the assigned officer', () => {
    expect(migration).toContain('for update');
    expect(migration).toContain('is_admin_for_org(v_stop.organization_id)');
    expect(migration).toContain('v_shift.officer_user_id <> auth.uid()');
    expect(migration).toContain('Not authorised to update this shift stop');
  });

  it('race-checks the expected status and validates the pending -> en_route -> on_scene -> completed lifecycle', () => {
    expect(migration).toContain('v_stop.status <> p_expected_status');
    expect(migration).toContain('Shift stop changed from expected status');
    expect(migration).toContain("when 'pending' then p_next_status in ('en_route', 'skipped', 'cancelled')");
    expect(migration).toContain("when 'en_route' then p_next_status in ('on_scene', 'skipped', 'cancelled')");
    expect(migration).toContain("when 'on_scene' then p_next_status in ('completed', 'skipped', 'cancelled')");
    expect(migration).toContain('Invalid shift stop transition');
  });

  it('computes SLA status and arrival/departure timestamps server-side rather than accepting client input', () => {
    expect(migration).toContain("when p_next_status = 'on_scene' and now() > v_stop.sla_arrive_by then 'breached'");
    expect(migration).toContain('actual_arrived_at = case');
    expect(migration).toContain('actual_departed_at = case');
  });

  it('is granted to authenticated callers, not just service_role', () => {
    expect(migration).toContain('grant execute on function public.advance_shift_stop_status(uuid, text, text, text, double precision, double precision) to authenticated, service_role');
  });

  it('is present in the generated schema dump', () => {
    expect(schema).toContain('CREATE OR REPLACE FUNCTION "public"."advance_shift_stop_status"');
  });
});
