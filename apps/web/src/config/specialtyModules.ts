import type { LucideIcon } from 'lucide-react';
import { Activity, Car, Shield, Tent, Volume2, Wind } from 'lucide-react';

export type SpecialtyModuleKey =
  | 'freedom_camping'
  | 'parking_enforcement'
  | 'noise_control'
  | 'biosecurity'
  | 'smoke_complaints'
  | 'static_guarding';

export interface SpecialtyModuleDefinition {
  key: SpecialtyModuleKey;
  integratedKey: string;
  label: string;
  description: string;
  icon: LucideIcon;
  standalonePath: string;
}

export const SPECIALTY_MODULES: readonly SpecialtyModuleDefinition[] = [
  { key: 'freedom_camping', integratedKey: 'freedom_camping', label: 'Freedom Camping', description: 'Vehicle scans and breach observations', icon: Tent, standalonePath: '/modules/freedom_camping' },
  { key: 'parking_enforcement', integratedKey: 'parking', label: 'Parking Enforcement', description: 'Chalk, recheck, and enforcement', icon: Car, standalonePath: '/modules/parking_enforcement' },
  { key: 'noise_control', integratedKey: 'noise_control', label: 'Noise Control', description: 'Assessments and notices', icon: Volume2, standalonePath: '/modules/noise_control' },
  { key: 'biosecurity', integratedKey: 'biosecurity', label: 'Biosecurity', description: 'Inspections and compliance evidence', icon: Activity, standalonePath: '/modules/biosecurity' },
  { key: 'smoke_complaints', integratedKey: 'smoke_control', label: 'Smoke Control', description: 'Complaints and field outcomes', icon: Wind, standalonePath: '/modules/smoke_complaints' },
  { key: 'static_guarding', integratedKey: 'site_guard', label: 'Static Guarding', description: 'Checkpoints and site security', icon: Shield, standalonePath: '/modules/static_guarding' },
];

export const SPECIALTY_MODULE_BY_KEY = Object.fromEntries(
  SPECIALTY_MODULES.map((module) => [module.key, module]),
) as Record<SpecialtyModuleKey, SpecialtyModuleDefinition>;