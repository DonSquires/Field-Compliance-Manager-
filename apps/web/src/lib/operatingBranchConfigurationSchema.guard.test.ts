import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260905005900_govern_operating_branch_configuration.sql'), 'utf8');

describe('operating branch configuration governance', () => {
  it('requires a selected active operating branch for every configuration mutation', () => {
    expect(migration.match(/user_can_operate_organization/g)?.length).toBeGreaterThanOrEqual(3);
    expect(migration).toContain("organization_type='branch' and active");
  });

  it('keeps operational module enablement separate from Layer 1 subscription changes', () => {
    expect(migration).toContain('set_operating_branch_module');
    expect(migration).toContain('Active platform module required');
    expect(migration).not.toContain('org_module_subscriptions');
  });

  it('limits geofence keys and audits every branch configuration change', () => {
    expect(migration).toContain("'site_provisional_radius_m'");
    expect(migration).toContain("'operating_branch_geofence_config_'||p_action");
  });
});