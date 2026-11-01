# Canon — the order of authority for Field Compliance Manager

This folder is the specification layer every build attempt must be tested
against. It consolidates the good bits of every previous line — the GitLab
"clean rebuild" (`don-squires1/field-compliance-manager`), the Freedom Camping
prototypes, and this repository — into one place with one order of authority.
When two documents disagree, the higher one wins; when code disagrees with canon,
the code is wrong **or** a ruling must be recorded here before the code stands.

Owner ruling 2026-09-15: **Field Compliance Manager is the single target build.**
GitLab, FreedomCamp-Manager / FreedomCamp-Manager-App, Onspace previews, and
other historical repos are lineage evidence only. They may supply requirements,
acceptance examples, sample workflows, and mistakes to avoid; they are not
parallel products and cannot overrule this canon, Atlas, the live schema, or
`docs/REBUILD_PLAN.md`.

Owner ruling 2026-11-01: **one service provider; client approval is not a
condition of service.** R & M Security and Investigations is the only service
provider, Iron Eagle is the billing and app-management owner, and no other
organisation may sign up. A provider's current operational agreement is enough
to deliver service; client acceptance gates only client-side disclosure. The
ruling is recorded in [`ORG_SERVICE_MODEL.md`](ORG_SERVICE_MODEL.md#owner-ruling-2026-11-01--one-service-provider-client-approval-is-not-a-condition-of-service).

## Order of authority

1. [`FOUNDATION.md`](../../FOUNDATION.md) (repo root) — why the app exists:
   accountability recorded honestly, preserved faithfully, proved in court. The
   anchor rule (harmed party + place of harm; operator is custodian, not owner).
2. [`ACCESS_DOCTRINE.md`](ACCESS_DOCTRINE.md) — the three-question test
   (authorised / needs / role) every sensitive read composes from.
3. [`ACCESS_MODEL.md`](ACCESS_MODEL.md) — the ratified, executable access
   constitution: standing authority vs situational entitlement, two place gates,
   six task signals, R1–R4, disclosure depths, the 13-scenario oracle.
4. [`ORG_SERVICE_MODEL.md`](ORG_SERVICE_MODEL.md) — Model A: every organisation
   own-rooted; provider/client role contextual per `service_agreement`; two-layer
   billing; the three user org columns.
5. [`LOCATION_HOUSE_MODEL.md`](LOCATION_HOUSE_MODEL.md) — one place = one house
   (`locations`) with Site (`client_sites`) and Zone (`location_zones`) facets;
   legacy names; overlapping time-aware module zones; three-layer gating.
6. [`UNIFIED_FIELD_OPERATIONS_MODEL.md`](UNIFIED_FIELD_OPERATIONS_MODEL.md) —
   "every field role is a guard on a place for a shift, with a toolset";
   assignments, stops, presence, base toolkit, specialty tools, NZ legal
   framework, key design principles.
7. [`PLATFORM_ENGINES_AND_MODULE_PROFILE.md`](PLATFORM_ENGINES_AND_MODULE_PROFILE.md)
   — two engines (geofence, Bob); a module is a data profile, never a code
   branch; the single test for every future decision.
8. [`GEOFENCE_PRINCIPLES.md`](GEOFENCE_PRINCIPLES.md) — P1 no silent fallback,
   P2 visual verification gate, four tiers, `resolve_context`, rulings Q1–Q10.
9. [`MODULE_INTEGRATION_CONTRACT.md`](MODULE_INTEGRATION_CONTRACT.md) — how a
   module registers into the eight shared spines; reference manifest in
   [`reference/moduleManifest.gitlab.ts`](reference/moduleManifest.gitlab.ts).
10. [`BOB_DOCTRINE.md`](BOB_DOCTRINE.md) — ONE BOB, two rails, egress not cage,
    impact tiers and readiness, runtime contract, open owner decisions.
11. [`DATA_CLASSIFICATION.md`](DATA_CLASSIFICATION.md) and
    [`RETENTION_DOCTRINE.md`](RETENTION_DOCTRINE.md) — Privacy Act vocabulary and
    retention posture (both pending legal confirmation).
12. [`PRODUCT_DESIGN.md`](PRODUCT_DESIGN.md) — tokens, three shells, the
    four-state officer entry machine, court-readiness UI requirements. Read with
    [`../BOB_ENTERPRISE_SAAS_UX_TRAINING.md`](../BOB_ENTERPRISE_SAAS_UX_TRAINING.md)
    and [`../ui-baseline.md`](../ui-baseline.md).
13. [`FREEDOM_CAMPING_IMPLEMENTATION_BLUEPRINT.md`](FREEDOM_CAMPING_IMPLEMENTATION_BLUEPRINT.md)
    — the reference vertical for the vehicle-compliance style.
13a. [`NOISE_CONTROL_TWO_PLACE_MODEL.md`](NOISE_CONTROL_TWO_PLACE_MODEL.md) — the
    reference design for the dual-place (RMA / environmental) style: complainant
    place and source place on one job, both geofenced, protected identity,
    statute verified at source; smoke and biosecurity follow it.
14. [`ALIGNMENT_LEDGER.md`](ALIGNMENT_LEDGER.md) — the audited gap between the
    foundation and what RLS enforces today (W1 access-side / W2 record-side).
15. [`../FCM_PLATFORM_ARCHITECTURE_BRIEF.md`](../FCM_PLATFORM_ARCHITECTURE_BRIEF.md),
    [`../MODULE_BASELINE_REQUIREMENTS.md`](../MODULE_BASELINE_REQUIREMENTS.md),
    [`../INSTRUCTION_MANUAL.md`](../INSTRUCTION_MANUAL.md) — this repository's
    operating brief, module baselines and role matrix, read under the canon.
16. [`../REBUILD_PLAN.md`](../REBUILD_PLAN.md) — the sequenced work that brings
    the build into conformance, with evidence gates.

`reviews/` holds review artifacts from the lineage (enterprise readiness, the
2026-07 all-rings app audit, parking dry-run, welfare and patrol investigations,
the Marlborough RFIP contract scope). They are evidence and lessons, not
authority. [`SHIPS_LOG.md`](SHIPS_LOG.md) is the crew's shared origin story and
is readable by everyone, including Bob.

## Ground truth beneath the canon

- `supabase/schema.sql` — regenerated from the live catalog
  (`scripts/schema-snapshot-live.mjs`); never hand-appended.
- Atlas (`bob_capability_map`, `bob_app_map_edges`) — generated terrain, read
  with `AGENTS.md`'s playbook; `flow_reach` ≠ `fk_reach`, `wired` ≠ `exercised`.
- Live database facts — read-only, scoped, through the governed paths in
  `AGENTS.md`.
- GitLab lineage — readable through `scripts/gitlab-read.mjs`; it is history and
  evidence, not the authoritative home.

## How to use this folder

Before shared-terrain work: read 1–3, then the document that owns the domain
you are touching, then `REBUILD_PLAN.md` for where that work sits in sequence.
Every substantial finding is reported as *expected vs present* across
before / during / after, and a ruling that changes canon is recorded in the
owning document with its date and author — the way the lineage did it.
