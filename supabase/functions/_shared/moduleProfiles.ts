// moduleProfiles.ts — Deno-side mirror of the module capability profiles (C2, #240).
//
// Deno edge functions cannot import packages/shared (workspace packages are not
// resolvable in the Deno runtime), so the SUBSET the conductor needs is mirrored
// here — the same pattern as _shared/auth.ts mirrors the tier model.
//
// SOURCE OF TRUTH: packages/shared/src/moduleManifest.ts (ModuleCapabilityProfile
// + MODULE_MANIFEST[*].profile). This file MUST stay in lockstep with it. Drift
// is the recurring runtime-bug class — a CI parity test comparing the two module
// lists + zoneType/perception values should guard this (tracked with C2/#240).
//
// Only the fields the planner map needs are mirrored (key, label, profile). The
// per-org BEHAVIOURAL overlay (module_rule_sets / jurisdiction_rule_sets) is read
// live at use time, never mirrored.
const Z = (zoneType, moduleKey, compliance, perc, moduleRules, jurisdictionRules, bespoke)=>({
    hasZones: true,
    hasSites: true,
    zoneType,
    zoneModuleKey: moduleKey,
    onsiteProfile: 'boundary',
    perception: perc,
    rules: {
      compliance,
      moduleRules,
      jurisdictionRules
    },
    storage: {
      spineNative: bespoke.length === 0,
      bespokeTables: bespoke
    }
  });
const SITE_ONLY = (onsite, perc, moduleRules, jurisdictionRules, bespoke)=>({
    hasZones: false,
    hasSites: true,
    zoneType: null,
    zoneModuleKey: null,
    onsiteProfile: onsite,
    perception: perc,
    rules: {
      compliance: null,
      moduleRules,
      jurisdictionRules
    },
    storage: {
      spineNative: bespoke.length === 0,
      bespokeTables: bespoke
    }
  });
const INFRA = {
  hasZones: false,
  hasSites: false,
  zoneType: null,
  zoneModuleKey: null,
  onsiteProfile: null,
  perception: {
    kind: null,
    key: null
  },
  rules: {
    compliance: null,
    moduleRules: false,
    jurisdictionRules: false
  },
  storage: {
    spineNative: true,
    bespokeTables: []
  }
};
// Mirror of MODULE_MANIFEST[*].{key,label,profile}. Keep in lockstep.
export const SHARED_MODULE_PROFILES = [
  {
    key: 'freedom_camping',
    label: 'Freedom Camping',
    profile: Z('freedom_camping', 'freedom_camping', 'zone_compliance_matrix', {
      kind: 'alpr',
      key: 'vehicle'
    }, true, true, [
      'observations',
      'breach_alerts',
      'breach_records',
      'infringement_notices',
      'notices_to_vacate'
    ])
  },
  {
    key: 'parking_enforcement',
    label: 'Parking Enforcement',
    profile: Z('parking', 'parking_enforcement', 'zone_compliance_matrix', {
      kind: 'alpr',
      key: 'vehicle'
    }, true, true, [
      'parking_sessions',
      'parking_chalk_records',
      'parking_infringement_notices'
    ])
  },
  {
    key: 'patrol',
    label: 'Patrol',
    profile: Z('patrol_route', 'patrol', null, {
      kind: null,
      key: null
    }, false, false, [])
  },
  {
    key: 'noise_control',
    label: 'Noise Control',
    profile: SITE_ONLY('approach_10m', {
      kind: 'classify',
      key: 'noise_equipment'
    }, true, true, [
      'noise_assessments',
      'noise_seizures'
    ])
  },
  {
    key: 'biosecurity',
    label: 'Biosecurity',
    profile: SITE_ONLY('approach_10m', {
      kind: 'classify',
      key: 'species'
    }, true, true, [
      'biosecurity_assessments'
    ])
  },
  {
    key: 'smoke_complaints',
    label: 'Smoke Control',
    profile: SITE_ONLY('approach_10m', {
      kind: 'classify',
      key: 'smoke_source'
    }, true, true, [
      'smoke_assessments'
    ])
  },
  {
    key: 'static_guarding',
    label: 'Static Guarding',
    profile: SITE_ONLY('boundary', {
      kind: null,
      key: null
    }, false, false, [])
  },
  {
    key: 'access_control',
    label: 'Access Control',
    profile: SITE_ONLY('boundary', {
      kind: null,
      key: null
    }, false, false, [])
  },
  // ems: INFRA, not SITE_ONLY. RULED (owner, 2026-08-19): EMS is an independent
  // asset management system for each PERSON in each branch, across the whole
  // organization. It follows the person, not a place — so hasSites: false and
  // onsiteProfile: null are correct, and the manifest was the accurate side.
  // Note this makes EMS structurally like welfare: person-scoped, not
  // place-scoped. Do not "restore" the site-attached shape.
  {
    key: 'ems',
    label: 'EMS',
    profile: INFRA
  },
  {
    key: 'ptt_radio',
    label: 'PTT Radio',
    profile: INFRA
  },
  {
    key: 'client_reporting',
    label: 'Client Reporting',
    profile: INFRA
  },
  {
    key: 'invoicing',
    label: 'Invoicing & Finance',
    profile: INFRA
  },
  // welfare: follows the OFFICER, not a place. hasZones/hasSites both false so
  // welfare never stops protecting an officer who leaves mapped geometry.
  // NOT INFRA: welfare OWNS welfare_alerts + officer_welfare_settings, so it is
  // spineNative: false with those two as bespokeTables. Mirrors
  // MODULE_MANIFEST.welfare.profile exactly.
  //
  // RESTORED (!1472). This entry was added by !1468, corrected by !1469, and
  // then LOST from Main by the conflict-resolution merge 88a68452. Both the
  // welfare entry and the ems ruling comment above disappeared from Main even
  // though !1469's own pipeline was green. If this vanishes again, suspect the
  // merge/conflict path, not the authoring commit.
  {
    key: 'welfare',
    label: 'Welfare Monitoring',
    profile: {
      hasZones: false,
      hasSites: false,
      zoneType: null,
      zoneModuleKey: null,
      onsiteProfile: null,
      perception: {
        kind: null,
        key: null
      },
      rules: {
        compliance: null,
        moduleRules: false,
        jurisdictionRules: false
      },
      storage: {
        spineNative: false,
        bespokeTables: [
          'welfare_alerts',
          'officer_welfare_settings'
        ]
      }
    }
  },
  {
    key: 'bob_assistant',
    label: 'Bob Assistant',
    profile: INFRA
  }
];
/**
 * Build the module map for the planner: ALL modules, each tagged `enabled` for
 * the active org (Option A — full structural map, not just enabled modules).
 * `enabledKeys` is the set of module_key values the org has turned on
 * (organization_modules.enabled = true).
 */ export function buildModuleMap(enabledKeys) {
  return SHARED_MODULE_PROFILES.map((m)=>({
      key: m.key,
      label: m.label,
      enabled: enabledKeys.has(m.key),
      profile: m.profile
    }));
}
