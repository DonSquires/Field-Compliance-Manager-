/**
 * One module-access rule for every shell (owner ruling 2026-10-27, docs/canon/ACCESS_MODEL.md):
 * a module is usable when the organisation switch is on AND the person is admin-tier or holds the
 * personal module tick. Place, geofence and rule-set resolution supply context only; they never
 * grant or remove access to a module.
 */
import { SPECIALTY_MODULES } from '../config/specialtyModules';
import { isAdminTierRole } from './roles';

const CANONICAL_BY_ALIAS = new Map<string, string>(
  SPECIALTY_MODULES.flatMap((module) => [[module.key, module.key], [module.integratedKey, module.key]] as const),
);
const OFFICER_ROUTE_BY_CANONICAL = new Map<string, string>(SPECIALTY_MODULES.map((module) => [module.key, module.integratedKey]));

/** Organisation switches and the module catalogue use the canonical key (e.g. parking_enforcement). */
export function canonicalModuleKey(moduleKey: string): string {
  return CANONICAL_BY_ALIAS.get(moduleKey) ?? moduleKey;
}

/** The officer portal routes specialty modules by their integrated key (e.g. /officer/parking). */
export function officerRouteModuleKey(moduleKey: string): string {
  const canonical = canonicalModuleKey(moduleKey);
  return OFFICER_ROUTE_BY_CANONICAL.get(canonical) ?? canonical;
}

export function hasPersonalModuleTick(moduleAccess: readonly string[] | null | undefined, moduleKey: string): boolean {
  const canonical = canonicalModuleKey(moduleKey);
  return (moduleAccess ?? []).some((granted) => canonicalModuleKey(granted) === canonical);
}

export interface ModuleAccessInput {
  moduleKey: string;
  role: string | null | undefined;
  moduleAccess: readonly string[] | null | undefined;
  isModuleEnabled: (moduleKey: string, options?: { safetyRelevant?: boolean }) => boolean;
  safetyRelevant?: boolean;
}

export function canUseModule({ moduleKey, role, moduleAccess, isModuleEnabled, safetyRelevant }: ModuleAccessInput): boolean {
  const organisationSwitchOn = isModuleEnabled(canonicalModuleKey(moduleKey), { safetyRelevant });
  if (!organisationSwitchOn) return false;
  return isAdminTierRole(role) || hasPersonalModuleTick(moduleAccess, moduleKey);
}
