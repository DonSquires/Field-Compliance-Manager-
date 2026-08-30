import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260830141000_govern_welfare_alert_transitions.sql'), 'utf8');

describe('governed welfare alert transitions', () => {
  it('locks and race-checks every safety transition', () => {
    expect(sql).toContain('where a.id=p_alert_id for update');
    expect(sql).toContain('v_alert.status<>p_expected_status');
    expect(sql).toContain('Welfare action notes are required');
  });

  it('limits acknowledgement to supervisors and self-resolution to the officer', () => {
    expect(sql).toContain('Only an authorized supervisor can acknowledge this alert');
    expect(sql).toContain('v_alert.officer_user_id<>v_actor');
    expect(sql).toContain("v_alert.status not in('pending','acknowledged')");
  });

  it('audits actor-specific safety outcomes and closes direct updates', () => {
    expect(sql).toContain("'welfare_alert_resolved_by_supervisor'");
    expect(sql).toContain("'welfare_alert_resolved_by_officer'");
    expect(sql).toContain('revoke update,delete on public.welfare_alerts');
  });
});