# Deep Build Audit - 2026-09-08

## Scope

This audit covered the web UI, browser workflows, Supabase migrations and schema dump, Atlas extraction and live Atlas state, repository tests, production build, and deployment-oriented configuration. Existing uncommitted work was treated as user-owned and was not reverted.

## Verification baseline

- Root suite: 456 tests passed.
- Web unit and contract suite: 725 tests passed.
- Production web build: passed; Vite reports a 3.57 MB minified vendor chunk.
- Atlas check: calibration and graph checks passed; dry-run manifest reports 849 capabilities and 2,991 edges.
- Focused Atlas refresh suite after remediation: 16 tests passed.
- Browser suite after remediation: 160 passed, 25 failed, 1 skipped, across 186 desktop/mobile tests.
- Focused readiness workflow: 2 passed on desktop and mobile.
- Focused core officer and entitlement workflows: 18 passed on desktop and mobile.

## Findings

### High: browser release baseline is still red

Twenty-five Playwright cases remain failing. Most are optional officer module workflows (parking, noise, biosecurity, smoke, overnight, scan, and static guard) whose shared fixture supplies no organization-enabled field modules while the tests navigate directly to those modules. The new shell correctly blocks those routes, but the fixture does not model the entitlement required by the tests. Three additional failures are visual snapshots (Bob panel, field operations, and organization setup), and two notification outcomes still fail to reach their expected context.

This must be resolved before treating the browser suite as release evidence: either give each fixture an explicit enabled-module profile or change those tests to verify the intended blocked state. Do not globally grant every module just to make the suite green.

### High: canonical schema dump is behind migrations

Migration `20260907001000_investigation_workspace_and_followup_dispatch.sql` creates `investigations`, `investigation_links`, `investigation_events`, investigation RPCs, and dispatch/report foreign keys. Those entities are absent from `supabase/schema.sql`, even though live Atlas reports them as present and wired. The dump is therefore not a reliable standalone deployment/review artifact until regenerated from the applied database state.

The same drift appears in older CRM readiness and organization RPC names: current UI uses `get_crm_enterprise_readiness` and `update_operating_branch_profile`, while the canonical dump and several guard fixtures still carry the retired names.

### High: Atlas managed-source coverage is incomplete

The managed extractor explicitly lists 39 of 275 migrations; 236 migrations are outside `MANAGED_SOURCES`, including most of the latest dispatch, investigation, roster, CCTV, Bob, retention, and Atlas migrations. A passing `atlas:check` therefore proves extractor health for the managed subset, not graph completeness for the build.

The audit repaired one concrete omission, `20260905005900_govern_operating_branch_configuration.sql`, and added dynamic RPC branch extraction. The inventory still needs a governed policy for which migrations are intentionally excluded and automated drift detection for newly added migrations.

### High: investigation link RPC accepts unvalidated entity references

`link_investigation_entity` validates the investigation administrator but does not verify that `p_entity_id` exists, belongs to the same organization, or is compatible with `p_entity_type` for entity types other than field reports and incidents. This permits dangling or cross-tenant references in `investigation_links`. The entity-specific update predicates do not protect the generic link row itself.

`p_lead_user_id` in `create_investigation` is also accepted without same-organization validation. The RPC should validate referenced users and all supported entity types before inserting the link.

### Medium: investigation creation is not atomic at the UI contract boundary

`FieldReportsPage` creates an investigation and then makes a second RPC call to link the field report. If linking fails, the user is left with an orphan investigation and an error stating only that the link failed. Prefer one server-owned command that creates and links atomically, or provide a governed compensating close/delete workflow.

### Medium: live Atlas exercise evidence is not established

Live capability rows for the investigation RPCs and tables report `exercised: null`. This is expected from static refresh, but it means “wired” is not evidence that the workflows have executed against the deployed database. Exercise receipts should be produced by seeded integration workflows and retained separately from static Atlas generation.

### Medium: production bundle has a performance warning

The production build succeeds but emits a 3.57 MB minified vendor chunk. The app has many lazy page chunks, yet the shared vendor chunk remains large enough to threaten first-load performance on field devices. Profile the chunk composition and split heavy libraries such as maps, icons, and document/visual tooling behind route-level imports.

### Low: snapshot baseline drift is not triaged

The browser suite reports visual differences in the Bob panel, field operations landing, and organization setup mobile module card. These may be intentional UI changes or regressions; they need human review before snapshots are updated. Do not bulk-update snapshots while the entitlement failures are unresolved.

## Remediation completed during this audit

- Atlas extraction now records both literal branches of conditional RPC selection.
- Atlas managed sources now include the current operating-branch configuration migration.
- Stale Atlas assertions were aligned with current provider quote, readiness, access-control, and branch-profile RPCs.
- Readiness dialog normalizes missing `dimensions` instead of crashing on malformed/legacy RPC payloads.
- Readiness E2E fixture now intercepts the current enterprise-readiness RPC.
- Officer shell keeps core officer services reachable while optional field modules remain grant-gated.
- The requested-breach scroll effect remains at component scope rather than inside an async loader.

## Recommended order

1. Fix the 25 browser failures by making optional-module fixtures explicit and triaging the three snapshots.
2. Regenerate and verify `supabase/schema.sql` from the applied database, then add CI drift detection.
3. Expand or formalize Atlas migration coverage and add a managed-source completeness check.
4. Harden investigation entity and lead-user validation in a migration, with cross-tenant negative tests.
5. Replace two-step investigation creation/linking with an atomic governed command.
6. Profile and split the large vendor bundle.