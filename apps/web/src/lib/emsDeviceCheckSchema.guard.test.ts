import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260901020000_ems_device_check_and_alert_response.sql'), 'utf8');
const schema = readFileSync(resolve(process.cwd(), '../../supabase/schema.sql'), 'utf8');

describe('submit_ems_device_check / respond_to_ems_alert schema', () => {
  it('authorises the assigned officer or an org admin to submit a device check', () => {
    expect(migration).toContain('is_admin_for_org(v_device.organization_id)');
    expect(migration).toContain("p.role in ('officer', 'admin_officer')");
    expect(migration).toContain('Not authorised to check this device');
  });

  it('auto-raises a critical tamper alert and flags the device when tamper is observed', () => {
    expect(migration).toContain("insert into ems_alerts (organization_id, device_id, alert_type, severity, status)");
    expect(migration).toContain("values (v_device.organization_id, p_device_id, 'tamper', 'critical', 'active')");
    expect(migration).toContain("update ems_devices set status = 'tampered'");
  });

  it('race-checks the alert lifecycle and requires an outcome to close', () => {
    expect(migration).toContain('for update');
    expect(migration).toContain('v_alert.status <> p_expected_status');
    expect(migration).toContain("when 'active' then p_next_status in ('acknowledged', 'resolved', 'false_alarm')");
    expect(migration).toContain('An outcome is required to close an alert');
  });

  it('is granted to authenticated callers and present in the generated schema dump', () => {
    expect(migration).toContain('grant execute on function public.submit_ems_device_check');
    expect(migration).toContain('grant execute on function public.respond_to_ems_alert');
    expect(schema).toContain('CREATE OR REPLACE FUNCTION "public"."submit_ems_device_check"');
    expect(schema).toContain('CREATE OR REPLACE FUNCTION "public"."respond_to_ems_alert"');
  });
});
