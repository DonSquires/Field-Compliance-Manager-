import type { AppRole } from '../context/AuthContext';

export const IDENTITY_ROLE_LEVEL: Record<AppRole, number> = {
  grand_master: 6,
  master: 5,
  admin: 4,
  admin_officer: 4,
  officer: 2,
  scan_operator: 2,
  nzscv_monitor: 1,
  client_admin: 1,
  client_officer: 1,
  client_viewer: 1,
  unknown: 0,
};

export const IDENTITY_ROLE_LABEL: Record<AppRole, string> = {
  grand_master: 'Grand Master',
  master: 'Master',
  admin: 'Administrator',
  admin_officer: 'Admin Officer',
  officer: 'Field Officer',
  scan_operator: 'Scan Operator',
  nzscv_monitor: 'NZSCV Monitor',
  client_admin: 'Client Administrator',
  client_officer: 'Client Officer',
  client_viewer: 'Client Viewer',
  unknown: 'Unknown',
};

const ASSIGNABLE_ROLES: AppRole[] = [
  'grand_master', 'master', 'admin', 'admin_officer', 'officer', 'scan_operator',
  'nzscv_monitor', 'client_admin', 'client_officer', 'client_viewer',
];

export function getAssignableRoles(callerRole: AppRole): AppRole[] {
  const callerLevel = IDENTITY_ROLE_LEVEL[callerRole];
  return ASSIGNABLE_ROLES.filter((role) => IDENTITY_ROLE_LEVEL[role] <= callerLevel);
}