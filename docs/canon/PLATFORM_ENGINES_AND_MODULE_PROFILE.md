> **Canonical copy.** Origin: GitLab `don-squires1/field-compliance-manager` `` @ `Main`, read 2026-09-14 via `scripts/gitlab-read.mjs`. This repository (`DonSquires/Field-Compliance-Manager-` `main`) is the authoritative home from now on; the GitLab text is lineage. Edit here and record the ruling — never fork the text. Links to files that do not exist in this repo refer to that lineage.

# Platform Engines & Module-as-Data — North Star (Definitive)

> Status: RATIFIED direction (owner, this session). Parent architectural anchor.
> The Bob-facing half is `docs/bob/BOB_CORE_ENGINE_NORTH_STAR.md` (!1099); read
> both together. Distilled from a full agentic review of BOTH apps (this app +
> the old `FreedomCamp-Manager`) and cross-verified against the all-rings
> `docs/APP_AUDIT_2026-07.md`.
>
> Purpose: give every future build a single test for "is this the right shape?"
> so the platform is built by CONFIGURATION over domain-blind engines, never by
> per-module/per-cage code branches. Multiple past sessions drifted into
> per-module handlers and a Bob cage; this doc is the guardrail against that.

---

## 1. The ultimate goal (what the whole app is for)

**Turn "a guard on a place for a shift, with a toolset" into governed,
court-defensible, billable, auditable field-compliance operations — across any
module, for any organisation, whether they buy one module or the whole build.**

The app's own unifying truth (`docs/ARCHITECTURE.md`): *"Every field role is a
guard on a place for a shift, with a toolset. Everything else is
configuration."* Freedom camping, parking, noise, biosecurity, smoke, patrol,
static guarding — none is a bespoke build. Each is the SAME spine (guard on a
place) plus one specialty tool.

The non-negotiable purpose everything serves (`docs/PRODUCT_DESIGN.md`): *"Every
action an officer takes in the field is potential court evidence."* So the
deliverable is DEFENSIBLE operations — evidence captured correctly, steps not
skippable, compliance provable, notices legally sound — and commercially whole
(contracts -> rosters -> shifts -> work -> evidence -> notices -> reports ->
invoices).

The end-to-end lifecycle the platform runs:

```
Contract (service agreement)
  -> roster (staff a place for a shift with a toolset)
    -> arrive (geofence flips on-site, reveals applicable modules + rules)
      -> do the work + capture evidence (shared evidence spine)
        -> assess compliance against the place's ruleset (data)
          -> generate notice / enforcement (legally grounded, court-ready)
            -> accumulate officer-safety history on the shared place record
              -> report to client + invoice (rate = bureau x zone-tier x SLA)
  ... with Bob reasoning across ALL of it, guiding work, surfacing
      cross-org H&S/risk, and doing the operational + development lifting.
```

---

## 2. The two core engines

The whole platform rests on two core operations. Every feature is one of these
serving the other.

### Engine 1 — GEOFENCE (where / what-applies)

> Owner's ruling, migration 0212: *"this whole app is triggered by geofences; it
> is simply a boundary that triggers activity and models -- step back and see it
> for what it is BEFORE reaching for a domain-specific rule."*

A boundary is **domain-blind**: it triggers activity, reveals which modules
apply at a point-and-time, supplies the governing ruleset, and anchors evidence.
The module/rules are attributes LAYERED on the boundary, never a property that
forks the geometry.

- Four-tier hierarchy (0127): provider jurisdiction -> patrol-route zone ->
  site -> checkpoint.
- Three resolution layers (`resolve_context`, 0090/0290): operating bounds
  (advisory) -> governing council jurisdiction (per-module rules, border
  auto-switch) -> site geofence (on-site + enabled modules).
- Time-aware, OVERLAPPING module geofences on one place (Montgomery Sq:
  freedom_camping overnight / parking daytime — two `location_zones` rows, same
  boundary, different `module_key` + schedule). Geometry is shared; module is
  data on top.
- Load-bearing with NO fallbacks: unset/unverified is a loud first-class state
  (P1); every boundary lands `unverified` until visually confirmed (P2, 0280).

`APP_AUDIT_2026-07` confirms the geofence spine underpins Compliance, Live Map,
zone detection, AND billing zone-tiers — it is the true backbone.

### Engine 2 — BOB (think / do)

The reasoning engine that plans, guides, acts, learns, and proactively surfaces
risk/H&S across the whole fleet. Governed by two rails only (section 4). Full
definition: `docs/bob/BOB_CORE_ENGINE_NORTH_STAR.md`.

Bob is NOT a governed data-entry form. He is a self-thinking, proactive,
heuristic agent whose autonomy is impact-tiered + readiness-graduated. His
write path is ALREADY domain-blind (`bob-upsert-generic` inspects the live
schema; no per-entity column lists; free access to the whole build via a
read-only sensitive deny-list, not an allow-list).

---

## 3. Every module is DATA, not code (the module capability profile)

A module = a data profile over the engines, never a code branch:

```
module capability profile = {
  place-trigger:   geofence config    (attaches to geometry? on-site profile?)
  perception tool: which inference model + what it classifies      (DATA)
  ruleset:         compliance rules / rule table                   (DATA)
  outputs:         notices / reports / templates                   (DATA)
  storage:         shared spine table + module_key + jsonb payload  (DATA)
}
```

Adding a module = adding a profile (manifest entry + rule/template/model data).
No handler, no branch, no migration-per-module, no cage.

**Crucially, the profile substrate ALREADY EXISTS in the schema** and is
partly unused:
- `packages/shared/src/moduleManifest.ts` — the structural registry
  (`requiresSpines` already declares which modules need the `geofence_zones`
  spine = which attach to geometry).
- `module_rule_sets (module_key, evidence_requirements, approval_policy,
  report_template_code)` — a per-module operational profile table (0001),
  largely unused today.
- `jurisdiction_rule_sets (module_key, rules jsonb)` — per-module legal rules as
  data; read generically by `resolve_context` into `effective_rules jsonb`.
- `report_templates` / `notice_templates` — outputs as data.

Layering: the **manifest** is the platform-global STRUCTURAL profile (what a
module IS); `module_rule_sets` / `jurisdiction_rule_sets` are the per-org
BEHAVIOURAL overlay (how THIS council runs it). This is the "rules are data,
not code" principle (#144) applied to the module itself.

**Owner ruling 2026-10-09 — CCTV evidence vs camera installation/maintenance.**
The CCTV module owns footage intake, inference, human review, and evidence
packaging. Physical camera installation and maintenance belong to Workshop's
maintenance work-order flow, not to CCTV and not to a new CCL-specific module.
These are separate workflows; no direct evidence-to-work-order or camera-asset
link is required. They may share the existing canonical site/zone as their
location. Historical maintenance import must resolve the client organization and
place first, and must not enable finance or create billable lines implicitly.

---

## 4. The three domain-blind primitives (how the engines are built)

Beneath the two engines sit three domain-blind primitives. Every module is a
configuration over them.

1. **Geofence** — boundary triggers activity + applicable modules + ruleset.
2. **Inference** — TWO layers, one spine each:
   - Perception (edge): vision / ALPR / audio / classification. `apps/inference`
     (`/infer`, `/infer/alpr`, `/infer/compare`) + `inference_jobs(domain)` +
     `inference_results` are ALREADY a shared, module-agnostic spine.
   - Reasoning (Bob): language / planning / risk / cross-fleet insight.
3. **Governance / identity** — Star Trek rank (capability + tenant isolation via
   egress redaction) + NZ Privacy Act + evidence-defensibility. See
   `BOB_CORE_ENGINE_NORTH_STAR.md` for the two-rail model in full.

**Storage grammar (domain-blind, ~70% built):** a shared spine keyed by
`module_key` + a `metadata`/`payload` jsonb tail:
- `evidence_items (module_key, evidence_kind, metadata jsonb)` — shared across
  ALL modules.
- `observations (module_key, compliance_status, compliance_detail jsonb)` — one
  observation stream.
- `location_events (observed_entity_type, payload jsonb)` — single stream,
  detail in free jsonb (0113: "no god table").
- `client_sites` — the ONE shared address record every module attaches to
  (cross-module officer-safety history).
- Written by ONE schema-driven agentic path (`bob-upsert-generic`): inspect live
  schema -> map fields -> park unknowns in jsonb -> ask when unsure -> learn.

Rule: **shared spine + `module_key` + jsonb payload, written by the
schema-driven path, with module-specifics as DATA in jsonb — a bespoke
per-module table only when the spine genuinely cannot express it.**

---

## 5. The three usage patterns the architecture must serve simultaneously

This is WHY the shape must be engines + data, not per-module and not monolithic:

1. **Single-module standalone ("login and scan").** A council buys only freedom
   camping; a company buys only parking. Runs on the barebones spines
   (`supportsStandaloneMode`, no dispatch/roster). Demands: fully functional
   with ONE tool lit, NO hard cross-module coupling.
2. **Full-stack multi-module provider.** One guard, one shift, many modules,
   many places. Demands: the spine composes N tools; geofence resolves WHICH
   module applies here-and-now (overlap/time-aware).
3. **Whole build as a platform (fleet).** Many providers + their clients on one
   instance. Demands: cross-org reasoning WITHOUT cross-org leakage (the two
   rails). Bob's fleet-wide H&S/risk value lives here.

A per-module build breaks (2) and (3); a monolith breaks (1). Only
engines + module-as-data survives all three.

---

## 6. What is already domain-blind (the good foundation — build ON this)

- Geofence resolution (`resolve_context`) — module + time generic.
- Perception edge spine (`apps/inference`) — module-agnostic ONNX endpoints.
- Inference queue (`inference_jobs(domain)` / `inference_results`).
- Storage spine (`evidence_items`, `observations`, `location_events`,
  `client_sites`) — `module_key` + jsonb.
- Rules as data (`jurisdiction_rule_sets`, `module_rule_sets`).
- Bob's write path (`bob-upsert-generic`) — schema-driven, no allow-list.
- Modularity system (`moduleManifest.requiresSpines` + `organization_modules`
  gating) — `APP_AUDIT_2026-07` rates this "genuinely well-built".

---

## 7. The FC-first forks to unwind (named debt)

Same anti-pattern ("build FC, duplicate per module") appears at four layers.
Each has a generic foundation ALREADY sitting unused; unwinding = make the
action layer READ the foundation.

1. **Perception:** `classify-photo` has a hardcoded
   `module: biosecurity|smoke|noise|parking` switch + per-module prompt map +
   per-module DB columns (`bob_species_id`, `bob_classification`). Should be ONE
   domain-blind classify path where the module supplies prompt/model as DATA
   (from the profile), mirroring the already-generic `apps/inference`.
2. **Outputs:** `generate-notice` is template-driven (`notice_templates`,
   `{{variable}}`, council-uploadable) BUT falls back to hardcoded FCA-2011 HTML
   and an FC-shaped notice enum. The generic `notices` table already carries all
   types. Finish the template-driven path.
3. **Storage:** bespoke per-module detail tables (`noise_assessments`,
   `biosecurity_assessments`, `parking_sessions`, `parking_infringement_notices`)
   duplicate the generic spine. `docs/db/LIVE_SCHEMA_2026-07-15` already flags
   parking bypassing `evidence_files`/`compliance_notices`/`offence_infringements`.
   Prefer the shared spine + jsonb; keep bespoke only where genuinely needed.
4. **Geometry:** the Bob-facing zone/site geometry action is FC-hardcoded
   (`create_freedom_camping_zone`) even though `set_zone_geometry` /
   `set_site_geometry` + the 0280 gate are already module-agnostic. Generalise
   to ONE profile-driven create/update (epic &2, C7).

Separately, the ONE structural break (`APP_AUDIT_2026-07`): the geofence spine
still rides the deprecated `locations` table (tracked #7/#8/#9). Staged repoint
to `client_sites` + `location_zones` before it, since billing zone-tiers and
compliance ride the same spine.

---

## 8. The single test for every future decision

Before building anything, ask:

> **Does this make "a guard on a place with a tool" more UNIFIED, more
> COURT-DEFENSIBLE, and more SELF-DRIVEN by the two engines — or does it add a
> bespoke per-module / per-cage branch?**

- New module capability? -> add a DATA profile (manifest + rules + template +
  model key), not a handler.
- New Bob constraint? -> is it Rail 1 (rank/egress), Rail 2 (Privacy Act), or a
  load-bearing gate (geofence verification / protected path / Truth Protocol)?
  If not, it is cage — needs explicit owner sign-off (see
  `BOB_CORE_ENGINE_NORTH_STAR.md` sec 10).
- New data to store? -> shared spine + `module_key` + jsonb, via
  `bob-upsert-generic`. Bespoke table only if the spine truly cannot express it.
- New geometry/perception/output? -> read the profile; do NOT fork per module.

If a change fails this test, it is wrong by the app's own definition.

---

## 9. Relationship to the epic and the Bob north star

- `docs/bob/BOB_CORE_ENGINE_NORTH_STAR.md` (!1099) = the Bob-facing half
  (two-rail governance, impact tiers, readiness levels, de-caging).
- Epic **&2** ("Bob Core Engine — Phase 2") = the build arc that realises this
  doc: the module capability profile (C1), manifest -> planner (C2), de-caging
  (C3-C6), the generic geometry write layer (C7), cross-app H&S/risk (C8).
- This doc is the PARENT: the profile (C1) should unify the existing
  `module_rule_sets` + manifest + perception/output keys, not invent a new
  abstraction; C7's "generic geometry" and a future "generic classify" are the
  same unwinding of the section-7 forks.

---

## 10. Live anchors (verified this session, both apps)

- Unifying truth: `docs/ARCHITECTURE.md` ("guard on a place with a toolset").
- Court-evidence purpose: `docs/PRODUCT_DESIGN.md`; product scope
  `docs/PRODUCT_REQUIREMENTS.md`.
- Geofence domain-blind ruling: migration 0212; backbone
  `docs/GEOFENCE_ARCHITECTURE.md`; 0127 four-tier; 0090/0290 `resolve_context`;
  0280 verification gate.
- Inference spine: `apps/inference/server.js`; `inference_jobs`/`inference_results`
  (0001); `process-officer-scan`. Perception fork: `classify-photo`,
  `PhotoClassification.tsx`.
- Storage spine: `evidence_items`/`observations`/`location_events`/`client_sites`
  (0001/0002/0113); write path `bob-upsert-generic` +
  `docs/BOB_SCHEMA_DRIVEN_EXECUTOR.md` + `docs/BOB_DATA_ENTRY_EXTENSIBILITY.md`.
- Rules/outputs as data: `jurisdiction_rule_sets`/`module_rule_sets`/
  `report_templates` (0001); `generate-notice` + `notice_templates` (0197).
- Modularity + audit: `packages/shared/src/moduleManifest.ts`;
  `docs/APP_AUDIT_2026-07.md` (all-rings); `docs/db/LIVE_SCHEMA_2026-07-15.md`
  (storage-duplication findings).
- Governance: `resolveUserCapabilities`/`bobPersona.ts`/`_shared/auth.ts`;
  0188 + `redactOutgoing` (egress = tenant isolation + Privacy Act).
- Original Bob spec (old app): `FreedomCamp-Manager` `BOB_INSTRUCTIONS.md`
  (Data 2.0 persona, agentic tasks, impact tiers, readiness levels).
