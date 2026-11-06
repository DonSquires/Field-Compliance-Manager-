export const ROSTERING_HR_TABS = ['shift-templates', 'roster-rules', 'coverage', 'oncall', 'court'] as const;

export type WorkforceSection = 'roster-board' | 'roster-coverage' | 'roster-setup' | 'people-hr' | 'people-access';

export const ROSTER_SECTIONS: { key: WorkforceSection; label: string }[] = [
  { key: 'roster-board', label: 'Roster board' },
  { key: 'roster-coverage', label: 'Work units & coverage' },
  { key: 'roster-setup', label: 'Shift setup & open shifts' },
];

export const PEOPLE_SECTIONS: { key: WorkforceSection; label: string }[] = [
  { key: 'people-hr', label: 'Staff, pay & HR' },
  { key: 'people-access', label: 'Logins & access' },
];

/** HR-page views that belong to rostering: an explicit section, or a legacy deep link to a rostering tab. */
export function isRosteringHrView(search: string): boolean {
  const params = new URLSearchParams(search);
  if (params.has('profile')) return false;
  if (params.get('section') === 'rostering') return true;
  const tab = params.get('tab');
  return Boolean(tab && (ROSTERING_HR_TABS as readonly string[]).includes(tab));
}

export function workforceSectionFor(page: string, search: string): WorkforceSection | null {
  switch (page) {
    case 'roster': return 'roster-board';
    case 'roster-targets': return 'roster-coverage';
    case 'users': return 'people-access';
    case 'people-hr':
      if (new URLSearchParams(search).has('profile')) return 'people-hr';
      return isRosteringHrView(search) ? 'roster-setup' : 'people-hr';
    default: return null;
  }
}

export function shouldShowRosterSetupFallback(
  rosterPageEnabled: boolean,
  peoplePageEnabled: boolean,
  roleCanAccessRosters: boolean,
): boolean {
  return !rosterPageEnabled && peoplePageEnabled && roleCanAccessRosters;
}

export const ROSTER_SETUP_PATH = '/admin/people-hr?section=rostering';
