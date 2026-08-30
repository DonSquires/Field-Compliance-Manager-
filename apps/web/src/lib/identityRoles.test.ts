import { describe, expect, it } from 'vitest';
import { getAssignableRoles } from './identityRoles';

describe('identity role presentation policy', () => {
  it('prevents admins from offering master or grand-master assignment', () => {
    const roles = getAssignableRoles('admin');
    expect(roles).toContain('admin');
    expect(roles).toContain('scan_operator');
    expect(roles).not.toContain('master');
    expect(roles).not.toContain('grand_master');
  });

  it('allows masters to assign roles at or below master level', () => {
    const roles = getAssignableRoles('master');
    expect(roles).toContain('master');
    expect(roles).not.toContain('grand_master');
  });
});