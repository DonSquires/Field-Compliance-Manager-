import { describe, expect, it } from 'vitest';
import { isRosteringHrView, workforceSectionFor } from './workforceSections';

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

  it('leaves staff profiles and unrelated pages without a section strip', () => {
    expect(workforceSectionFor('people-hr', '?profile=s1&tab=coverage')).toBeNull();
    expect(isRosteringHrView('?profile=s1&section=rostering')).toBe(false);
    expect(workforceSectionFor('crm', '')).toBeNull();
  });
});
