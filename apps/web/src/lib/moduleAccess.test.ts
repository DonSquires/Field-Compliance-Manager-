import { describe, expect, it } from 'vitest';
import { canUseModule, canonicalModuleKey, hasPersonalModuleTick, officerRouteModuleKey } from './moduleAccess';

const enabled = (keys: string[]) => (moduleKey: string) => keys.includes(moduleKey);

describe('module access rule', () => {
  it('maps specialty aliases to one canonical key and one officer route', () => {
    expect(canonicalModuleKey('parking')).toBe('parking_enforcement');
    expect(canonicalModuleKey('site_guard')).toBe('static_guarding');
    expect(canonicalModuleKey('smoke_control')).toBe('smoke_complaints');
    expect(canonicalModuleKey('patrol')).toBe('patrol');
    expect(officerRouteModuleKey('parking_enforcement')).toBe('parking');
    expect(officerRouteModuleKey('static_guarding')).toBe('site_guard');
    expect(officerRouteModuleKey('freedom_camping')).toBe('freedom_camping');
  });

  it('treats a legacy alias tick as the same module', () => {
    expect(hasPersonalModuleTick(['parking'], 'parking_enforcement')).toBe(true);
    expect(hasPersonalModuleTick(['static_guarding'], 'site_guard')).toBe(true);
    expect(hasPersonalModuleTick([], 'patrol')).toBe(false);
  });

  it('requires the organisation switch for everyone', () => {
    for (const role of ['officer', 'admin', 'admin_officer', 'master']) {
      expect(canUseModule({ moduleKey: 'parking', role, moduleAccess: ['parking'], isModuleEnabled: enabled([]) })).toBe(false);
    }
  });

  it('requires the personal tick for field roles', () => {
    expect(canUseModule({ moduleKey: 'parking', role: 'officer', moduleAccess: [], isModuleEnabled: enabled(['parking_enforcement']) })).toBe(false);
    expect(canUseModule({ moduleKey: 'parking', role: 'officer', moduleAccess: ['parking_enforcement'], isModuleEnabled: enabled(['parking_enforcement']) })).toBe(true);
    expect(canUseModule({ moduleKey: 'static_guarding', role: 'supervisor', moduleAccess: ['site_guard'], isModuleEnabled: enabled(['static_guarding']) })).toBe(true);
  });

  it('gives admin-tier roles, including admin_officer, every organisation-enabled module', () => {
    for (const role of ['grand_master', 'master', 'admin', 'admin_officer']) {
      expect(canUseModule({ moduleKey: 'noise_control', role, moduleAccess: [], isModuleEnabled: enabled(['noise_control']) })).toBe(true);
    }
  });

  it('passes the safety flag through to the organisation switch', () => {
    const calls: Array<boolean | undefined> = [];
    canUseModule({ moduleKey: 'welfare', role: 'admin', moduleAccess: [], safetyRelevant: true, isModuleEnabled: (_key, options) => { calls.push(options?.safetyRelevant); return false; } });
    expect(calls.every((flag) => flag === true)).toBe(true);
  });
});
