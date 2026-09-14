> **Canonical copy.** Origin: GitLab `don-squires1/field-compliance-manager` `` @ `Main`, read 2026-09-14 via `scripts/gitlab-read.mjs`. This repository (`DonSquires/Field-Compliance-Manager-` `main`) is the authoritative home from now on; the GitLab text is lineage. Edit here and record the ruling — never fork the text. Links to files that do not exist in this repo refer to that lineage.

# Module Integration Contract

> How any module (existing or new) plugs into the platform's shared spines so it
> works seamlessly regardless of what it does. This is the human contract; the
> machine-readable half is `packages/shared/src/moduleManifest.ts` (A1).
>
> Source of truth for issue #1 (Modular productisation). Read alongside
> `docs/STAGING.md`, `docs/ARCHITECTURE.md`.

---

## Principle

A module is a **thin, separable package** that contributes its own capture screens,
admin settings, data tables and report slice, and **inherits everything else** from
the shared platform spines. Clients buy modules independently (LINZ = freedom
camping only; Nelson City Council = freedom camping + noise; West Coast = parking),
and any combination composes without per-module rework.

Two orthogonal axes, never conflated:

- **Module enablement** (`organization_modules`) = what the ORG bought. Gates nav,
  officer tiles, report slices.
- **Access profile / role** (`user_profiles.module_access`, and #3
  `access_role_profiles`) = what the USER may touch. Gates per-user.

A surface shows only when **enabled for the org AND permitted for the user**.

---

## Shared spines (every org has these; not sold per-module)

| Spine | Provides |
|-------|----------|
| `org_site_setup` | organisations, client sites, org module enablement |
| `users_roles` | users, roles, access profiles, invites (`create-user`) |
| `geofence_zones` | `location_zones`, boundaries, jurisdiction geom |
| `dispatch_roster` | shifts, roster, dispatch jobs, patrol attendance |
| `evidence_capture` | photo/evidence upload, OCR, the universal ReportButton (VOI/POI/LOI) |
| `reporting` | report packs, report templates, client reporting |
| `invoicing` | invoices, rates, commercial settings |
| `bob` | in-app AI copilot (advisory + governed data entry) |

A module declares which spines it needs via `requiresSpines[]` in the manifest. It
MUST NOT re-implement a spine; it registers into it.

---

## The manifest is the registration point

Every module has exactly one entry in `MODULE_MANIFEST` (`moduleManifest.ts`):

```ts
{
  key: ModuleKey,            // canonical module key (packages/shared/src/modules.ts)
  label, icon, description,
  sellable: boolean,         // appears in the owner pricing catalog (#2)
  adminPages: string[],      // AdminShell page keys this module owns
  officerModule: string|null,// OfficerShell module value (field portal), or null
  settingsPages: string[],   // admin config/settings page keys (subset of adminPages)
  tables: string[],          // this module's OWN data tables (live-schema-aligned)
  reportSlice: string|null,  // report-pack slice key, or null
  requiresSpines: SharedSpine[],
}
```

Gating, reporting, per-module settings, and pricing all read this ONE registry
instead of scattered maps. Helpers: `moduleForAdminPage()`, `moduleForOfficerValue()`,
`sellableModules()`.

---

## Contract: adding a NEW module

Do these, in order. Nothing else should need to change in other modules.

1. **Canonical key** — add the `ModuleKey` in `packages/shared/src/modules.ts`.
2. **Manifest entry** — add the module to `MODULE_MANIFEST` with its pages,
   officer value, tables, report slice, settings pages, and `requiresSpines`.
   Verify table names against the LIVE schema first (standing rule).
3. **Data tables** — migration for the module's own operational table(s) +
   (if it has admin-set rules) a config row in `module_rule_sets` or a dedicated
   `*_config` table. Org-scoped, RLS `org_access_allowed(organization_id)`.
4. **Officer surface** — add the field capture page + `MODULE_META` entry +
   `renderModuleContent()` case in `OfficerShell`. The module tile auto-gates via
   the manifest + org enablement (A3). Mount the ReportButton inside the portal
   (already automatic for field modules).
5. **Admin surface** — add the admin page(s) + `renderPage()` case + nav item in
   `AdminShell`. Nav auto-gates via the manifest + org enablement (A2).
6. **Settings surface** — add the module's admin rules page (see A5 finding); wire
   thresholds to `module_rule_sets`/`*_config`, not hardcoded constants.
7. **Report slice** — contribute the module's columns to the report pack under its
   `reportSlice` key (A4). Gate the slice by org enablement.
8. **Pricing** — add the module to the owner catalog (`module_catalog`, #2); it is
   automatically listed because `sellable: true` in the manifest.
9. **Bob awareness** — the module's tables become writable via the schema-driven
   executor automatically (Bob discovers live tables; sensitive tables stay
   read-only). No per-module Bob code needed for straightforward data entry.

---

## Contract: registering into each spine

- **geofence_zones** — reference `location_zones` / `client_sites`; use
  `save_zone_boundary` / `save_site_boundary` RPCs. Do not create a parallel zone
  table.
- **dispatch_roster** — module jobs attend via dispatch/patrol (e.g. `NCCNOISE`
  noise jobs are attended by a patrol shift). Roster by `service_type` = the
  module/officer value.
- **evidence_capture** — reuse `EvidencePhotoUpload` + the universal ReportButton;
  store under `org/{org_id}/evidence/{module}/{record_id}/...`.
- **reporting** — contribute a `reportSlice`; the report pack composes enabled
  slices only.
- **invoicing** — billable service maps through `crm_commercial_settings` /
  `site_financial_config` / `rate_rules` (do not invent a per-module rate table).
- **bob** — nothing to register; the schema-driven executor + read-only deny-list
  handle new tables. Add a knowledge card if the module needs grounded answers.

---

## Non-negotiables

- **Never re-implement a spine.** Register into it.
- **Never hardcode org-specific rules/thresholds** in a module page — put them in
  the module's config (`module_rule_sets`/`*_config`), admin-editable.
- **Always org-scope + RLS** every module table (`org_access_allowed`).
- **Gate every surface** by org enablement (and user access). Fail-open only for
  unconfigured orgs (see A2/A3).
- **Verify columns against the live schema** before writing any migration or
  executor mapping.

---

## Related

- A1 manifest: `packages/shared/src/moduleManifest.ts`
- A2 admin gating: `AdminShell.tsx` (`PAGE_REQUIRED_MODULE`)
- A3 officer gating: `OfficerShell.tsx` + `hooks/useEnabledModules.ts`
- A5 settings audit: issue #1 comment (specialty modules need settings surfaces)
- Charging: issue #2 (owner catalog + provider on-charge)
- Access profiles: issue #3 (`access_role_profiles`)
