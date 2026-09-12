import type { LucideIcon } from 'lucide-react';
import { BriefcaseBusiness, Radio, ShieldCheck, Users } from 'lucide-react';

export interface CommandCentreGroup {
  key: string;
  label: string;
  description: string;
  accent: 'blue' | 'green' | 'purple' | 'orange' | 'amber' | 'red';
  icon: LucideIcon;
  statLabel: string;
  stat: 'activeDispatch' | 'onDuty' | 'breaches' | null;
  allowedRoles: string[];
  links: Array<readonly [string, string]>;
  openLabel: string;
  open: string;
}

export const ADMIN_COMMAND_CENTRE_GROUPS: readonly CommandCentreGroup[] = [
  {
    key: 'clients', label: 'Clients & CRM', description: 'Client accounts, sites, contacts and agreements', accent: 'blue', icon: BriefcaseBusiness, statLabel: 'active clients', stat: null,
    allowedRoles: ['admin', 'master', 'grand_master'],
    links: [['CRM Hub', 'crm'], ['Client Sites', 'site-360'], ['Organisations', 'relationships'], ['Contacts', 'users'], ['Contracts', 'onboarding']],
    openLabel: 'Open Clients & CRM', open: 'crm',
  },
  {
    key: 'services', label: 'Services & Dispatch', description: 'Dispatch jobs, patrol services and call signs', accent: 'green', icon: Radio, statLabel: 'active jobs', stat: 'activeDispatch',
    allowedRoles: ['admin', 'master', 'grand_master', 'officer'],
    links: [['Dispatch', 'dispatch'], ['Jobs List', 'dispatch'], ['Monitor', 'field-ops'], ['Job Map', 'live-map'], ['Ops Map', 'live-map'], ['Site Guard', 'access-control'], ['Access Control', 'access-control'], ['Noise Control', 'noise-control'], ['Parking', 'parking'], ['EMS', 'field-ops']],
    openLabel: 'Open Services & Dispatch', open: 'field-ops',
  },
  {
    key: 'rostering', label: 'Rostering & Workforce', description: 'Shifts, timesheets, open shifts and call signs', accent: 'purple', icon: Users, statLabel: "today's shifts", stat: 'onDuty',
    allowedRoles: ['admin', 'master', 'grand_master', 'officer'],
    links: [['Roster Planner', 'roster'], ['Timesheets', 'people-hr'], ['Open Shifts', 'roster'], ['Availability', 'roster'], ['Patrol Schedule', 'roster'], ['Patrol KPIs', 'reports']],
    openLabel: 'Open Rostering & Workforce', open: 'roster',
  },
  {
    key: 'people', label: 'Staff & People', description: 'User management, officer welfare and live tracking', accent: 'orange', icon: Users, statLabel: 'on patrol now', stat: 'onDuty',
    allowedRoles: ['admin', 'master', 'grand_master'],
    links: [['Users', 'users'], ['Welfare', 'welfare-alerts'], ['Live Tracking', 'live-map'], ['Skills', 'people-hr'], ['Person Records', 'people-hr'], ['ID Check', 'users']],
    openLabel: 'Open Staff & People', open: 'people-hr',
  },
  {
    key: 'pricing', label: 'Pricing & Invoicing', description: 'Per-client service rates, contracts and invoices', accent: 'amber', icon: BriefcaseBusiness, statLabel: 'active contracts', stat: null,
    allowedRoles: ['admin', 'master', 'grand_master'],
    links: [['Assets', 'finance-costing'], ['Service Rates', 'rate-rules'], ['Invoices', 'finance-money'], ['Contracts', 'crm'], ['Timesheets', 'people-hr']],
    openLabel: 'Open Pricing & Invoicing', open: 'finance-bureau',
  },
  {
    key: 'compliance', label: 'Compliance & Enforcement', description: 'Breaches, infringements, notices and disputes', accent: 'red', icon: ShieldCheck, statLabel: 'open alerts', stat: 'breaches',
    allowedRoles: ['admin', 'master', 'grand_master', 'officer'],
    links: [['Compliance', 'reports'], ['Breaches', 'breach-review'], ['Command', 'field-ops'], ['Infringements', 'breach-review'], ['Disputes', 'approvals'], ['Notices', 'reports'], ['NTV', 'vehicle-search'], ['NZSCV', 'vehicle-search'], ['Spatial', 'sites']],
    openLabel: 'Open Compliance & Enforcement', open: 'reports',
  },
];
