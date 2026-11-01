export type FieldOpsSubArea = 'landing' | 'dispatch' | 'patrol' | 'live-map' | 'officer-activity' | 'welfare-alerts' | 'breach-review' | 'vehicle-search' | 'person-search' | 'observation-search' | 'field-reports' | 'operational-continuity' | 'cctv-console' | 'cctv-triage' | 'cctv-quality' | 'cctv-review' | 'cctv-library' | 'cctv-import' | 'debrief-followup' | 'parking' | 'noise-control' | 'biosecurity' | 'smoke-control';

export const FIELD_OPS_AREAS: ReadonlySet<FieldOpsSubArea> = new Set([
  'landing', 'dispatch', 'patrol', 'live-map', 'officer-activity', 'welfare-alerts', 'breach-review', 'vehicle-search', 'person-search',
  'field-reports', 'operational-continuity', 'observation-search', 'cctv-console', 'cctv-triage', 'cctv-quality', 'cctv-review', 'cctv-library', 'cctv-import', 'parking', 'noise-control', 'biosecurity', 'smoke-control',
  'debrief-followup',
]);

type ModuleRequirement = {
  anyOf: readonly string[];
  safetyRelevant?: boolean;
};

type ModuleAccessCheck = (moduleKey: string, options?: { safetyRelevant?: boolean }) => boolean;

const AREA_MODULE_REQUIREMENTS: Partial<Record<FieldOpsSubArea, ModuleRequirement>> = {
  dispatch: { anyOf: ['dispatch'] },
  patrol: { anyOf: ['patrol', 'static_guarding'] },
  'live-map': { anyOf: ['dispatch'] },
  'welfare-alerts': { anyOf: ['welfare'], safetyRelevant: true },
  'breach-review': { anyOf: ['freedom_camping', 'parking_enforcement'] },
  'observation-search': { anyOf: ['freedom_camping', 'parking_enforcement', 'cctv'] },
  'cctv-console': { anyOf: ['cctv'] },
  'cctv-triage': { anyOf: ['cctv'] },
  'cctv-quality': { anyOf: ['cctv'] },
  'cctv-review': { anyOf: ['cctv'] },
  'cctv-library': { anyOf: ['cctv'] },
  'cctv-import': { anyOf: ['cctv'] },
  parking: { anyOf: ['parking_enforcement'] },
  'noise-control': { anyOf: ['noise_control'] },
  biosecurity: { anyOf: ['biosecurity'] },
  'smoke-control': { anyOf: ['smoke_complaints'] },
};

const PERSON_SEARCH_ROLES = new Set(['grand_master', 'master', 'admin', 'admin_officer']);

export function isFieldOpsSubArea(value: string | null): value is FieldOpsSubArea {
  return value !== null && FIELD_OPS_AREAS.has(value as FieldOpsSubArea);
}

export function canAccessFieldOpsArea(area: FieldOpsSubArea, isModuleEnabled: ModuleAccessCheck, role?: string): boolean {
  if (area === 'person-search' && !PERSON_SEARCH_ROLES.has(role ?? '')) return false;
  const requirement = AREA_MODULE_REQUIREMENTS[area];
  return !requirement || requirement.anyOf.some((moduleKey) => (
    isModuleEnabled(moduleKey, { safetyRelevant: requirement.safetyRelevant })
  ));
}