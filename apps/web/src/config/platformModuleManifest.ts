import type { LucideIcon } from 'lucide-react';
import { Activity, Briefcase, Building2, Car, HeartPulse, Radio, Video } from 'lucide-react';
import { SPECIALTY_MODULES } from './specialtyModules';

export type PlatformModuleKey =
  | 'freedom_camping'
  | 'parking_enforcement'
  | 'noise_control'
  | 'biosecurity'
  | 'smoke_complaints'
  | 'static_guarding'
  | 'crm'
  | 'rostering'
  | 'hr'
  | 'finance'
  | 'welfare'
  | 'dispatch'
  | 'cctv';

export interface PlatformModuleDefinition {
  key: PlatformModuleKey;
  label: string;
  description: string;
  icon: LucideIcon;
  /** True if an org can subscribe to this module on its own, with no others enabled. */
  standaloneSellable: boolean;
  /** Module keys that MUST already be enabled before this one can be. */
  dependsOn: PlatformModuleKey[];
}

// Field-ops verticals: zero hard dependency on each other or on CRM/Roster/HR/Finance
// (confirmed against supabase/functions/_shared/moduleProfiles.ts bespokeTables — each
// owns its own tables and none references another vertical's tables).
const FIELD_OPS_MODULES: PlatformModuleDefinition[] = SPECIALTY_MODULES.map((module) => ({
  key: module.key,
  label: module.label,
  description: module.description,
  icon: module.icon,
  standaloneSellable: true,
  dependsOn: [],
}));

// Platform modules: previously hardcoded as always-on core; now individually
// sellable via organization_modules/org_module_subscriptions (see migration
// 20260913110000_modular_platform_catalog.sql).
const PLATFORM_MODULES: PlatformModuleDefinition[] = [
  { key: 'crm', label: 'CRM', description: 'Accounts, agreements, quotes, and client relationships', icon: Building2, standaloneSellable: true, dependsOn: [] },
  { key: 'rostering', label: 'Rostering', description: 'Shifts, roster work units, and coverage', icon: Car, standaloneSellable: true, dependsOn: [] },
  { key: 'hr', label: 'HR', description: 'Leave, timesheets, and credentials', icon: Briefcase, standaloneSellable: true, dependsOn: [] },
  // Finance is not standalone: finance_pl_periods_and_cost_capture FKs cost
  // captures into shifts/roster_work_units — it has no data model without Rostering.
  { key: 'finance', label: 'Finance', description: 'Cost capture, P&L, and invoicing', icon: Activity, standaloneSellable: false, dependsOn: ['rostering'] },
  { key: 'welfare', label: 'Welfare Monitoring', description: 'Officer safety check-ins and alerts', icon: HeartPulse, standaloneSellable: true, dependsOn: [] },
  // Catalog rows added by 20260915120000_platform_subscriber_provisioning.sql.
  { key: 'dispatch', label: 'Dispatch', description: 'Callouts, alarm responses, dispatch jobs, and the live map', icon: Radio, standaloneSellable: true, dependsOn: [] },
  { key: 'cctv', label: 'CCTV', description: 'Camera footage library, review, and evidence packaging', icon: Video, standaloneSellable: true, dependsOn: [] },
];

export const PLATFORM_MODULE_MANIFEST: readonly PlatformModuleDefinition[] = [...FIELD_OPS_MODULES, ...PLATFORM_MODULES];

export const PLATFORM_MODULE_BY_KEY: Record<PlatformModuleKey, PlatformModuleDefinition> = Object.fromEntries(
  PLATFORM_MODULE_MANIFEST.map((module) => [module.key, module]),
) as Record<PlatformModuleKey, PlatformModuleDefinition>;

/** Modules that must already be enabled before `key` can be enabled, unresolved recursively. */
export function unmetDependencies(key: PlatformModuleKey, enabled: ReadonlySet<string>): PlatformModuleKey[] {
  const module = PLATFORM_MODULE_BY_KEY[key];
  if (!module) return [];
  return module.dependsOn.filter((dep) => !enabled.has(dep));
}
