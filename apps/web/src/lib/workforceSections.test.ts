import { describe, expect, it } from 'vitest';
import { isRosteringHrView, shouldShowRosterSetupFallback, workforceSectionFor } from './workforceSections';

describe('workforce sections', () => {
  it('places roster pages and the HR rostering view under Rosters', () => {
    expect(workforceSectionFor('roster', '')).toBe('roster-board');
    expect(workforceSectionFor('roster-targets', '?workUnitId=1')).toBe('roster-coverage');
    expect(workforceSectionFor('people-hr', '?section=rostering')).toBe('roster-setup');
  });

  it('keeps legacy rostering tab links under Rosters', () => {
    expect(isRosteringHrView('?tab=coverage')).toBe(true);
    expect(workforceSectionFor('people-hr', '?tab=oncall')).toBe('roster-setup');
  });

  it('places HR, pay and access under People', () => {
    expect(workforceSectionFor('people-hr', '')).toBe('people-hr');
    expect(workforceSectionFor('people-hr', '?tab=credentials&credential=abc')).toBe('people-hr');
    expect(workforceSectionFor('users', '')).toBe('people-access');
  });

  it('keeps staff profiles in People while excluding profile links from Rosters', () => {
    expect(workforceSectionFor('people-hr', '?profile=s1&tab=coverage')).toBe('people-hr');
    expect(isRosteringHrView('?profile=s1&section=rostering')).toBe(false);
    expect(workforceSectionFor('crm', '')).toBeNull();
  });

  it('offers HR-gated roster setup only when roster access is otherwise permitted', () => {
    expect(shouldShowRosterSetupFallback(false, true, true)).toBe(true);
    expect(shouldShowRosterSetupFallback(true, true, true)).toBe(false);
    expect(shouldShowRosterSetupFallback(false, false, true)).toBe(false);
    expect(shouldShowRosterSetupFallback(false, true, false)).toBe(false);
  });
});
