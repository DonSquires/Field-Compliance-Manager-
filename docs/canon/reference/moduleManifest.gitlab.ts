// Canonical reference copy (not compiled here). Origin: GitLab don-squires1/field-compliance-manager
// packages/shared/src/moduleManifest.ts @ Main, read 2026-09-14 via scripts/gitlab-read.mjs.
// This repo registers modules in apps/web/src/config/specialtyModules.ts,
// apps/web/src/config/platformModuleManifest.ts and supabase/functions/_shared/moduleProfiles.ts;
// see docs/canon/MODULE_INTEGRATION_CONTRACT.md for the target shape.

/**
 * moduleManifest.ts — declarative module registry (issue #1 A1)
 *
 * Single source of truth describing each sellable module's SURFACE:
 *   - admin page keys it contributes
 *   - the officer-shell module value (if it has a field portal)
 *   - its own data tables
 *   - the report slice it contributes
 *   - the shared spines it requires (always present for every org)
 *
 * Why: module gating, per-module settings, reporting slices, the owner pricing
 * catalog (issue #2), and Bob's "what is this module" all read ONE registry
 * instead of scattered maps. Adding a new module = add one entry here + its
 * pages; gating/reporting/pricing pick it up automatically.
 *
 * NOTE: this is descriptive metadata only (no behaviour). The web shells map
 * these page keys to their own route enums; edge/reporting logic reads `tables`
 * and `reportSlice`. Keep table names aligned with the LIVE schema.
 */

import type { ModuleKey } from './modules';

/** Shared platform spines every org has regardless of modules purchased. */
export type SharedSpine =
  | 'org_site_setup'
  | 'users_roles'
  | 'geofence_zones'
  | 'dispatch_roster'
  | 'evidence_capture'
  | 'reporting'
  | 'invoicing'
  | 'bob';

export interface ModuleManifestEntry {
  key: ModuleKey;
  label: string;
  icon: string;
  /** Short description for admin/pricing/Bob surfaces. */
  description: string;
  /** Is this a sellable/optional module, or an always-on core capability? */
  sellable: boolean;
  /**
   * Whether this module supports standalone "login and scan" mode — i.e. it can
   * operate with only the barebones spines (org_site_setup, users_roles,
   * geofence_zones, evidence_capture, reporting) and NO dispatch_roster
   * dependency. Specialty field modules (Parking, Noise, FC, Biosecurity, Smoke)
   * are standalone-capable; infrastructure modules are not.
   *
   * @see https://gitlab.com/don-squires1/field-compliance-manager/-/issues/150
   */
  supportsStandaloneMode: boolean;
  /** Admin page keys (AdminShell AdminPage values) this module contributes. */
  adminPages: string[];
  /** Officer-shell module value (moduleAccess / ActiveModule), if it has a field portal. */
  officerModule: string | null;
  /** Admin settings/config page keys for this module (subset of adminPages). */
  settingsPages: string[];
  /** This module's own data tables (verified against live schema). */
  tables: string[];
  /** Report-pack slice key this module contributes (null = none). */
  reportSlice: string | null;
  /** Shared spines this module depends on (always available). */
  requiresSpines: SharedSpine[];
  /**
   * Module CAPABILITY PROFILE (C1, epic &2 / #239) — the platform-global,
   * STRUCTURAL half of "a module is data, not code". It describes, as DATA, how
   * the domain-blind engines run this module, so no per-module handler code is
   * needed (see docs/architecture/PLATFORM_ENGINES_AND_MODULE_PROFILE.md).
   *
   * Domain-blind (migration 0212): geometry/perception/storage are generic
   * engines; this profile only supplies WHICH zone_type / model / rule-table the
   * module uses. The per-org BEHAVIOURAL overlay (thresholds, evidence rules,
   * templates) lives in the existing module_rule_sets / jurisdiction_rule_sets
   * tables, which this profile POINTS AT — it never duplicates their contents.
   *
   * Optional so the field can be populated incrementally; absent = treat as a
   * non-geospatial, no-perception module (safe default).
   */
  profile?: ModuleCapabilityProfile;
}

/**
 * The structural capability profile for a module (C1, #239).
 *
 * Every field is a POINTER or a FLAG, never module-specific behaviour: behaviour
 * is data in the overlay tables. Adding a module = filling this in (+ its overlay
 * rows), not writing a handler.
 */
export interface ModuleCapabilityProfile {
  /**
   * Does this module attach to geometry (create/own location_zones rows)?
   * Derived from requiresSpines including 'geofence_zones' — kept consistent so
   * the two signals never disagree.
   */
  hasZones: boolean;
  /** Does this module operate on client_sites (site-level presence/work)? */
  hasSites: boolean;
  /**
   * The EXPLICIT location_zones.zone_type value for this module's zones. MUST be
   * a value allowed by location_zones_zone_type_check (migration 0134):
   * freedom_camping | parking | noise_control | biosecurity | trespass |
   * access_control | general | patrol_route. NOTE this is NOT always the
   * module_key (parking_enforcement -> 'parking'; patrol -> 'patrol_route').
   * null when hasZones is false.
   */
  zoneType:
    | 'freedom_camping' | 'parking' | 'noise_control' | 'biosecurity'
    | 'trespass' | 'access_control' | 'general' | 'patrol_route' | null;
  /**
   * The location_zones.module_key value this module writes (module_key is a free
   * text column; this pins the canonical value). null when hasZones is false.
   */
  zoneModuleKey: string | null;
  /**
   * On-site activation profile (docs/GEOFENCE_ARCHITECTURE.md 2.3):
   *   'boundary'     — site polygon + onsite radius (patrol/parking/FC/static)
   *   'approach_10m' — tight 10 m ring before arrival (noise/biosecurity/smoke/alarm)
   *   null           — no on-site concept.
   */
  onsiteProfile: 'boundary' | 'approach_10m' | null;
  /**
   * Perception/inference tool this module uses at the edge, as DATA:
   *   kind — the generic pipeline (apps/inference / classify): 'alpr' (plate),
   *          'classify' (vision classification), or null (no perception).
   *   key  — the model/prompt key the generic path selects (e.g. 'vehicle',
   *          'species', 'smoke_source', 'noise_equipment'); null when kind null.
   * The generic perception path (C7-adjacent; unwinds classify-photo's per-module
   * switch) reads this — it is NOT a per-module code branch.
   */
  perception: { kind: 'alpr' | 'classify' | null; key: string | null };
  /**
   * The rule/behaviour overlay this module reads, as DATA pointers (never
   * inlined rules). All already exist in the schema:
   *   compliance — 'zone_compliance_matrix' (versioned per-zone rulebook) or null
   *   moduleRules — true if the module uses module_rule_sets (evidence reqs /
   *                 approval policy / report template) — the currently-unused
   *                 governed overlay table this profile adopts
   *   jurisdictionRules — true if per-council legal rules live in
   *                 jurisdiction_rule_sets.rules (read by resolve_context)
   */
  rules: {
    compliance: 'zone_compliance_matrix' | null;
    moduleRules: boolean;
    jurisdictionRules: boolean;
  };
  /**
   * Storage: the module's operational data should land in the SHARED spine keyed
   * by module_key + jsonb payload (evidence_items / observations /
   * location_events), NOT a bespoke per-module table. `bespokeTables` lists any
   * legacy per-module tables that exist today and are DEBT to fold into the spine
   * (docs/db/LIVE_SCHEMA_2026-07-15 findings) — empty [] = already spine-native.
   */
  storage: { spineNative: boolean; bespokeTables: string[] };
}

export const MODULE_MANIFEST: Record<ModuleKey, ModuleManifestEntry> = {
  freedom_camping: {
    key: 'freedom_camping',
    label: 'Freedom Camping',
    icon: '\uD83C\uDFD5\uFE0F',
    description: 'Freedom camping compliance: scanning, breach triage, notices, NZSCV, overnight verification and enforcement.',
    sellable: true,
    supportsStandaloneMode: true,
    adminPages: [
      'patrol', 'breach-review', 'fc-reporting', 'fc-scv-import', 'fc-notice-print',
      'fc-compliance', 'fc-nzscv', 'fc-overnight', 'fc-enforcement', 'fc-command-results', 'disputes',
    ],
    officerModule: 'freedom_camping',
    settingsPages: [],
    tables: [
      'observations', 'breach_alerts', 'breach_records', 'infringement_notices',
      'infringement_notice_counters', 'notices_to_vacate', 'disputes',
      'nzscv_records', 'vehicle_overnight_sessions', 'enforcement_cases', 'enforcement_case_events',
    ],
    reportSlice: 'freedom_camping',
    requiresSpines: ['org_site_setup', 'geofence_zones', 'dispatch_roster', 'evidence_capture', 'reporting'],
    profile: {
      hasZones: true,
      hasSites: true,
      zoneType: 'freedom_camping',
      zoneModuleKey: 'freedom_camping',
      onsiteProfile: 'boundary',
      perception: { kind: 'alpr', key: 'vehicle' },
      rules: { compliance: 'zone_compliance_matrix', moduleRules: true, jurisdictionRules: true },
      storage: { spineNative: false, bespokeTables: ['observations', 'breach_alerts', 'breach_records', 'infringement_notices', 'notices_to_vacate'] },
    },
  },
  parking_enforcement: {
    key: 'parking_enforcement',
    label: 'Parking Enforcement',
    icon: '\uD83C\uDD7F\uFE0F',
    description: 'Parking enforcement: chalking, parking sessions, time-limit breaches and notices.',
    sellable: true,
    supportsStandaloneMode: true,
    adminPages: ['parking'],
    officerModule: 'parking',
    settingsPages: [],
    tables: ['parking_sessions', 'parking_chalk_records', 'parking_module_config', 'parking_infringement_notices'],
    reportSlice: 'parking_enforcement',
    requiresSpines: ['org_site_setup', 'geofence_zones', 'evidence_capture', 'reporting'],
    profile: {
      hasZones: true,
      hasSites: true,
      zoneType: 'parking',
      zoneModuleKey: 'parking_enforcement',
      onsiteProfile: 'boundary',
      perception: { kind: 'alpr', key: 'vehicle' },
      rules: { compliance: 'zone_compliance_matrix', moduleRules: true, jurisdictionRules: true },
      storage: { spineNative: false, bespokeTables: ['parking_sessions', 'parking_chalk_records', 'parking_infringement_notices'] },
    },
  },
  noise_control: {
    key: 'noise_control',
    label: 'Noise Control',
    icon: '\uD83D\uDD0A',
    description: 'Noise control: assessments, seizures and attendance dispatched to patrols.',
    sellable: true,
    supportsStandaloneMode: true,
    adminPages: ['noise-control', 'noise-control-settings'],
    officerModule: 'noise_control',
    settingsPages: ['noise-control-settings'],
    tables: ['noise_assessments', 'noise_seizures', 'noise_module_config'],
    reportSlice: 'noise_control',
    requiresSpines: ['org_site_setup', 'dispatch_roster', 'evidence_capture', 'reporting'],
    profile: {
      hasZones: false,
      hasSites: true,
      zoneType: null,
      zoneModuleKey: null,
      onsiteProfile: 'approach_10m',
      perception: { kind: 'classify', key: 'noise_equipment' },
      rules: { compliance: null, moduleRules: true, jurisdictionRules: true },
      storage: { spineNative: false, bespokeTables: ['noise_assessments', 'noise_seizures'] },
    },
  },
  biosecurity: {
    key: 'biosecurity',
    label: 'Biosecurity',
    icon: '\uD83E\uDDA0',
    description: 'Biosecurity assessments and compliance.',
    sellable: true,
    supportsStandaloneMode: true,
    adminPages: ['biosecurity'],
    officerModule: 'biosecurity',
    settingsPages: [],
    tables: ['biosecurity_assessments'],
    reportSlice: 'biosecurity',
    requiresSpines: ['org_site_setup', 'evidence_capture', 'reporting'],
    profile: {
      hasZones: false,
      hasSites: true,
      zoneType: null,
      zoneModuleKey: null,
      onsiteProfile: 'approach_10m',
      perception: { kind: 'classify', key: 'species' },
      rules: { compliance: null, moduleRules: true, jurisdictionRules: true },
      storage: { spineNative: false, bespokeTables: ['biosecurity_assessments'] },
    },
  },
  smoke_complaints: {
    key: 'smoke_complaints',
    label: 'Smoke Control',
    icon: '\uD83D\uDCA8',
    description: 'Smoke/air-quality complaint assessments and compliance.',
    sellable: true,
    supportsStandaloneMode: true,
    adminPages: ['smoke-control'],
    officerModule: 'smoke_control',
    settingsPages: [],
    tables: ['smoke_assessments'],
    reportSlice: 'smoke_complaints',
    requiresSpines: ['org_site_setup', 'evidence_capture', 'reporting'],
    profile: {
      hasZones: false,
      hasSites: true,
      zoneType: null,
      zoneModuleKey: null,
      onsiteProfile: 'approach_10m',
      perception: { kind: 'classify', key: 'smoke_source' },
      rules: { compliance: null, moduleRules: true, jurisdictionRules: true },
      storage: { spineNative: false, bespokeTables: ['smoke_assessments'] },
    },
  },
  patrol: {
    key: 'patrol',
    label: 'Patrol',
    icon: '\uD83D\uDEB6',
    description: 'General security patrol: routes, checkpoints, live monitoring.',
    sellable: true,
    supportsStandaloneMode: false,
    adminPages: ['patrol-monitor', 'patrol-checkpoints', 'checkpoint-log', 'patrol-routes'],
    officerModule: 'patrol',
    settingsPages: [],
    tables: ['patrols', 'patrol_routes', 'patrol_checkpoints', 'patrol_checkpoint_visits'],
    reportSlice: 'patrol',
    requiresSpines: ['org_site_setup', 'geofence_zones', 'dispatch_roster', 'reporting'],
    profile: {
      hasZones: true,
      hasSites: true,
      zoneType: 'patrol_route',
      zoneModuleKey: 'patrol',
      onsiteProfile: 'boundary',
      perception: { kind: null, key: null },
      rules: { compliance: null, moduleRules: false, jurisdictionRules: false },
      storage: { spineNative: true, bespokeTables: [] },
    },
  },
  static_guarding: {
    key: 'static_guarding',
    label: 'Static Guarding',
    icon: '\uD83D\uDEE1\uFE0F',
    description: 'Static guard sites: rostered on-site presence.',
    sellable: true,
    supportsStandaloneMode: false,
    adminPages: [],
    officerModule: 'site_guard',
    settingsPages: [],
    tables: [],
    reportSlice: 'static_guarding',
    requiresSpines: ['org_site_setup', 'dispatch_roster', 'reporting'],
    profile: {
      hasZones: false,
      hasSites: true,
      zoneType: null,
      zoneModuleKey: null,
      onsiteProfile: 'boundary',
      perception: { kind: null, key: null },
      rules: { compliance: null, moduleRules: false, jurisdictionRules: false },
      storage: { spineNative: true, bespokeTables: [] },
    },
  },
  access_control: {
    key: 'access_control',
    label: 'Access Control',
    icon: '\uD83D\uDD10',
    description: 'Access control operations.',
    sellable: true,
    supportsStandaloneMode: false,
    adminPages: [],
    officerModule: null,
    settingsPages: [],
    tables: [],
    reportSlice: null,
    requiresSpines: ['org_site_setup'],
    profile: {
      hasZones: false,
      hasSites: true,
      zoneType: null,
      zoneModuleKey: null,
      onsiteProfile: 'boundary',
      perception: { kind: null, key: null },
      rules: { compliance: null, moduleRules: false, jurisdictionRules: false },
      storage: { spineNative: true, bespokeTables: [] },
    },
  },
  ems: {
    key: 'ems',
    label: 'EMS',
    icon: '\uD83D\uDCE1',
    description: 'Electronic monitoring / device checks.',
    sellable: true,
    supportsStandaloneMode: false,
    adminPages: [],
    officerModule: 'ems',
    settingsPages: [],
    tables: ['ems_devices', 'ems_device_checks', 'ems_alerts'],
    reportSlice: 'ems',
    requiresSpines: ['org_site_setup', 'reporting'],
    profile: {
      hasZones: false,
      hasSites: false,
      zoneType: null,
      zoneModuleKey: null,
      onsiteProfile: null,
      perception: { kind: null, key: null },
      rules: { compliance: null, moduleRules: false, jurisdictionRules: false },
      storage: { spineNative: true, bespokeTables: [] },
    },
  },
  ptt_radio: {
    key: 'ptt_radio',
    label: 'PTT Radio',
    icon: '\uD83D\uDCFB',
    description: 'Push-to-talk radio channels and transmissions.',
    sellable: true,
    supportsStandaloneMode: false,
    adminPages: [],
    officerModule: null,
    settingsPages: [],
    tables: ['ptt_channels', 'ptt_transmissions'],
    reportSlice: null,
    requiresSpines: ['org_site_setup'],
    profile: {
      hasZones: false,
      hasSites: false,
      zoneType: null,
      zoneModuleKey: null,
      onsiteProfile: null,
      perception: { kind: null, key: null },
      rules: { compliance: null, moduleRules: false, jurisdictionRules: false },
      storage: { spineNative: true, bespokeTables: [] },
    },
  },
  welfare: {
    key: 'welfare',
    label: 'Welfare Monitoring',
    icon: '\uD83E\uDDE1',
    description: 'Officer safety monitoring: welfare checks, man-down and SOS alerts, '
      + 'and the L1-L3 escalation ladder to the humans responsible for that officer.',
    // Sellable so it can be priced, subscribed, DELEGATED to a monitoring
    // provider via service_agreement_modules, and -- critically -- OPTED OUT of
    // (#362). Opt-out in this platform is expressed as a module not enabled;
    // welfare could not be declined because it was never opted into.
    sellable: true,
    // PTT-independent by doctrine (enforcement-architecture 12.1 / 12.3):
    // welfare must function through ANY available channel, so it cannot depend
    // on the dispatch/roster spine being present.
    supportsStandaloneMode: true,
    adminPages: ['welfare-monitor'],
    officerModule: 'welfare',
    settingsPages: [],
    tables: ['welfare_alerts', 'officer_welfare_settings'],
    reportSlice: null,
    requiresSpines: ['org_site_setup', 'users_roles', 'reporting'],
    profile: {
      // Welfare follows the OFFICER, not a place. An at-risk officer may be
      // anywhere -- inside a site, between sites, or off any known geometry --
      // so welfare must never be gated on zone or site presence.
      hasZones: false,
      hasSites: false,
      zoneType: null,
      zoneModuleKey: null,
      onsiteProfile: null,
      perception: { kind: null, key: null },
      // Per-officer escalation timings live in officer_welfare_settings, not in
      // module_rule_sets, so no rule overlay is pointed at here.
      rules: { compliance: null, moduleRules: false, jurisdictionRules: false },
      storage: { spineNative: false, bespokeTables: ['welfare_alerts', 'officer_welfare_settings'] },
    },
  },
  client_reporting: {
    key: 'client_reporting',
    label: 'Client Reporting',
    icon: '\uD83D\uDCC8',
    description: 'Client-facing reporting portal and monthly report packs.',
    sellable: true,
    supportsStandaloneMode: false,
    adminPages: ['report-packs', 'reports-hub', 'obligations'],
    officerModule: null,
    settingsPages: [],
    tables: ['monthly_report_packs', 'report_templates'],
    reportSlice: null,
    requiresSpines: ['reporting'],
    profile: {
      hasZones: false,
      hasSites: false,
      zoneType: null,
      zoneModuleKey: null,
      onsiteProfile: null,
      perception: { kind: null, key: null },
      rules: { compliance: null, moduleRules: false, jurisdictionRules: false },
      storage: { spineNative: true, bespokeTables: [] },
    },
  },
  invoicing: {
    key: 'invoicing',
    label: 'Invoicing & Finance',
    icon: '\uD83D\uDCB3',
    description: 'Invoicing, payment tracking, rates and financial setup.',
    sellable: true,
    supportsStandaloneMode: false,
    adminPages: ['invoicing', 'generate-invoice', 'payments', 'oncall', 'financial-setup', 'rate-rules'],
    officerModule: null,
    settingsPages: ['financial-setup', 'rate-rules'],
    tables: ['invoices', 'invoice_line_items', 'invoice_line_templates', 'crm_commercial_settings', 'site_financial_config', 'rate_rules'],
    reportSlice: 'invoicing',
    requiresSpines: ['invoicing'],
    profile: {
      hasZones: false,
      hasSites: false,
      zoneType: null,
      zoneModuleKey: null,
      onsiteProfile: null,
      perception: { kind: null, key: null },
      rules: { compliance: null, moduleRules: false, jurisdictionRules: false },
      storage: { spineNative: true, bespokeTables: [] },
    },
  },
  bob_assistant: {
    key: 'bob_assistant',
    label: 'Bob Assistant',
    icon: '\uD83E\uDD16',
    description: 'In-app AI copilot (advisory + governed data entry).',
    sellable: true,
    supportsStandaloneMode: false,
    adminPages: [],
    officerModule: null,
    settingsPages: [],
    tables: ['bob_conversations', 'bob_messages'],
    reportSlice: null,
    requiresSpines: ['bob'],
    profile: {
      hasZones: false,
      hasSites: false,
      zoneType: null,
      zoneModuleKey: null,
      onsiteProfile: null,
      perception: { kind: null, key: null },
      rules: { compliance: null, moduleRules: false, jurisdictionRules: false },
      storage: { spineNative: true, bespokeTables: [] },
    },
  },
};

/** All manifest entries as a list. */
export const MODULE_MANIFEST_LIST: ModuleManifestEntry[] = Object.values(MODULE_MANIFEST);

/** Sellable modules only (for the owner pricing catalog, issue #2). */
export function sellableModules(): ModuleManifestEntry[] {
  return MODULE_MANIFEST_LIST.filter((m) => m.sellable);
}

/**
 * Modules that support standalone "login and scan" mode — no dispatch_roster
 * dependency. Used by agreement setup, onboarding, and the /scan entry point.
 * @see https://gitlab.com/don-squires1/field-compliance-manager/-/issues/150
 */
export function standaloneModules(): ModuleManifestEntry[] {
  return MODULE_MANIFEST_LIST.filter((m) => m.supportsStandaloneMode);
}

/** Reverse lookup: admin page key -> the module that owns it (or null if core/shared). */
export function moduleForAdminPage(pageKey: string): ModuleKey | null {
  for (const entry of MODULE_MANIFEST_LIST) {
    if (entry.adminPages.includes(pageKey)) return entry.key;
  }
  return null;
}

/** Reverse lookup: officer module value -> canonical ModuleKey (or null). */
export function moduleForOfficerValue(officerModule: string): ModuleKey | null {
  for (const entry of MODULE_MANIFEST_LIST) {
    if (entry.officerModule === officerModule) return entry.key;
  }
  return null;
}

// ── Module capability profile accessors (C1, #239) ───────────────────────────
// The domain-blind engines (geofence, inference, storage) and the planner read
// these instead of branching per module. A module's behaviour is DATA (the
// profile + the overlay tables it points at), never code.

/**
 * Safe default profile for a module whose `profile` is not yet populated:
 * non-geospatial, no perception, spine-native. Never throws — callers always
 * get a usable shape.
 */
const DEFAULT_PROFILE: ModuleCapabilityProfile = {
  hasZones: false,
  hasSites: false,
  zoneType: null,
  zoneModuleKey: null,
  onsiteProfile: null,
  perception: { kind: null, key: null },
  rules: { compliance: null, moduleRules: false, jurisdictionRules: false },
  storage: { spineNative: true, bespokeTables: [] },
};

/** The capability profile for a module (falls back to the safe default). */
export function moduleProfile(key: ModuleKey): ModuleCapabilityProfile {
  return MODULE_MANIFEST[key]?.profile ?? DEFAULT_PROFILE;
}

/**
 * Modules that attach to geometry (create/own location_zones). This is the true
 * "all zones for all modules" set the generic geometry write layer (C7) serves;
 * it GROWS by adding profile data, never code. Today: freedom_camping, parking
 * enforcement, patrol.
 */
export function geometryModules(): ModuleManifestEntry[] {
  return MODULE_MANIFEST_LIST.filter((m) => (m.profile ?? DEFAULT_PROFILE).hasZones);
}

/** Reverse lookup: a location_zones.zone_type value -> the owning ModuleKey (or null). */
export function moduleForZoneType(zoneType: string): ModuleKey | null {
  for (const entry of MODULE_MANIFEST_LIST) {
    if ((entry.profile ?? DEFAULT_PROFILE).zoneType === zoneType) return entry.key;
  }
  return null;
}

/**
 * Consistency guard: a module's profile.hasZones MUST agree with whether
 * requiresSpines includes 'geofence_zones'. The two signals describe the same
 * fact from two sides and must never drift. Returns the list of modules where
 * they disagree (empty = consistent). Intended for a unit test / CI check.
 */
export function profileSpineMismatches(): ModuleKey[] {
  const bad: ModuleKey[] = [];
  for (const entry of MODULE_MANIFEST_LIST) {
    const declaresSpine = entry.requiresSpines.includes('geofence_zones');
    const hasZones = (entry.profile ?? DEFAULT_PROFILE).hasZones;
    if (declaresSpine !== hasZones) bad.push(entry.key);
  }
  return bad;
}
