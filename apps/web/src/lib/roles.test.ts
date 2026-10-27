import { describe, expect, it } from 'vitest';
import { ADMIN_TIER_ROLES, isAdminTierRole } from './roles';

describe('admin-tier roles', () => {
  it('treats admin_officer exactly like admin', () => {
    for (const role of ['grand_master', 'master', 'admin', 'admin_officer']) expect(isAdminTierRole(role)).toBe(true);
    expect(ADMIN_TIER_ROLES.size).toBe(4);
  });

  it('excludes field, scan, monitor and client roles', () => {
    for (const role of ['officer', 'scan_operator', 'nzscv_monitor', 'client_admin', 'client_officer', 'client_viewer', 'unknown', '', null, undefined]) {
      expect(isAdminTierRole(role)).toBe(false);
    }
  });
});
