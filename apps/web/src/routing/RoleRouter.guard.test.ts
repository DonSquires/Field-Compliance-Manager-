/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const router = readFileSync(resolve(process.cwd(), 'src/routing/RoleRouter.tsx'), 'utf8');

describe('RoleRouter recovery and prefix contracts', () => {
  it('does not render a blank screen when the authenticated profile is unavailable', () => {
    expect(router).toContain('Profile unavailable');
    expect(router).not.toContain('if (!profile) return null');
  });

  it('lets users sign out from unknown-role and missing-profile dead ends', () => {
    expect(router).toContain('AccountAccessState');
    expect(router).toContain('Unknown role');
    expect(router).toContain('onSignOut={signOut}');
    expect(router).toContain('Sign out');
  });

  it('enforces role URL prefixes on path boundaries only', () => {
    expect(router).toContain('function isWithinRolePrefix');
    expect(router).toContain('path === expectedPrefix || path.startsWith(`${expectedPrefix}/`)');
    expect(router).not.toContain('path.startsWith(expectedPrefix)');
  });
});