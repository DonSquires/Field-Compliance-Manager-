import { describe, expect, it } from 'vitest';
import { canAccessFieldOpsArea, isFieldOpsSubArea } from './fieldOpsAreaAccess';

describe('Field Operations area entitlement', () => {
  it('keeps shared workflows available without inventing a module gate', () => {
    expect(canAccessFieldOpsArea('landing', () => false)).toBe(true);
    expect(canAccessFieldOpsArea('field-reports', () => false)).toBe(true);
    expect(canAccessFieldOpsArea('operational-continuity', () => false)).toBe(true);
    expect(canAccessFieldOpsArea('debrief-followup', () => false)).toBe(true);
    expect(canAccessFieldOpsArea('officer-activity', () => false)).toBe(true);
  });

  it('allows a workspace when any supported module is enabled', () => {
    expect(canAccessFieldOpsArea('patrol', (moduleKey) => moduleKey === 'static_guarding')).toBe(true);
    expect(canAccessFieldOpsArea('breach-review', (moduleKey) => moduleKey === 'parking_enforcement')).toBe(true);
    expect(canAccessFieldOpsArea('observation-search', (moduleKey) => moduleKey === 'cctv')).toBe(true);
  });

  it('blocks disabled workspaces and requires confirmed safety entitlement for welfare', () => {
    expect(canAccessFieldOpsArea('cctv-console', () => false)).toBe(false);
    expect(canAccessFieldOpsArea('welfare-alerts', (moduleKey, options) => moduleKey === 'welfare' && options?.safetyRelevant !== true)).toBe(false);
    expect(canAccessFieldOpsArea('welfare-alerts', (moduleKey, options) => moduleKey === 'welfare' && options?.safetyRelevant === true)).toBe(true);
  });

  it('recognizes only implemented Field Operations sub-areas', () => {
    expect(isFieldOpsSubArea('dispatch')).toBe(true);
    expect(isFieldOpsSubArea('operational-continuity')).toBe(true);
    expect(isFieldOpsSubArea('unregistered-tool')).toBe(false);
    expect(isFieldOpsSubArea(null)).toBe(false);
  });
});