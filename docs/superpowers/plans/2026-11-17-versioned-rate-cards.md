# Versioned Rate Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace loose pay and charge rules with finance-approved, versioned rate cards that preserve historic pricing while providing one governed source for client, place, payroll, quote, dispatch and patrol rates.

**Architecture:** Keep `rate_rules` as the detailed rate line and preserve its IDs for already-priced evidence. Add card/version ownership and stable line lineage, route resolution through approved versions, and attach agreements and selectable references to a card or rate lineage. Move every rate-writing path behind draft → submit → finance approval; build the Rate cards page over governed RPCs, then update existing readers and entry points without moving materials out of the price book.

**Tech Stack:** Supabase Postgres migrations and disposable PostgreSQL tests, React/TypeScript, Vitest, Playwright, Node `node:test`.

**Spec:** [2026-11-17-rate-cards-design.md](../specs/2026-11-17-rate-cards-design.md)

## Global Constraints

- An approved rate-card version is immutable.
- A new rate or changed rate does not apply until someone with finance access approves it.
- A client may have several cards; each agreement selects its card, with one client default.
- Price resolution is place override → agreement card → client default card → branch Standard card.
- A card only overrides Standard for matching rate lines; Standard supplies missing lines.
- Priced, accepted, invoiced, paid, or exported records keep the rate and amount used when priced.
- Never resolve an absent or pending price as `$0`; report “needs a rate” or “pending approval”.
- Materials and consumables remain in Prices & discounts; equipment operating rates belong on rate cards.
- Digger and similar equipment charge operating hours and towing kilometres; this phase displays equipment cost/margin but does not capture usage.
- Finance approvers are authorized operating-branch finance administrators; approval decisions are audited and request-idempotent.
- Preserve `resolve_rate_rule` specificity within a card and every existing tenant, role, place and date check.
- Do not hand-edit `supabase/schema.sql` or Atlas. Regenerate schema from the live catalog after governed migration application and refresh Atlas through its governed scripts.
- Before changing shared schema or resolvers, run Atlas preflight and cross-check live schema; keep `flow_reach` and `fk_reach` separate.
- Keep current routes stable unless a route change is required; update visible labels and links together.
- Use the existing FCM design tokens, plain NZ English, and accessible loading, empty, error, success, permission, and responsive states.

## Review Focus

1. A previously selected place/schedule price must follow its lineage after approval while already-priced evidence retains its original rule and amount. Test pinned selection continuity and immutable charge-line history in Tasks 3 and 6.
2. A client-card match must beat Standard only for the same rate request, while Standard still fills gaps. Test equal-specificity card precedence, Standard site-specific fallback, and unchanged specificity within a card in Task 3.
3. Multiple agreements for one client may resolve different cards, while no-card agreements use the one client default. Test agreement scope, default selection, and tenant isolation in Tasks 1 and 3.
4. Rate creation from Finance, place setup, staff HR, and Bob must never become active before approval. Test each entry path, denied approver and lost-response replay in Tasks 2 and 4.
5. A backdated version must not reprice completed/invoiced work; conflicting price changes found by the 90-day dry run must be surfaced for owner action. Test immutable lines and dry-run discrepancy output in Tasks 1 and 3.

---

## File Map

**Database and migration tests**
- Create four additive migrations under `supabase/migrations/` in order: card foundation and safe rule assignment; version lifecycle; resolver and reference integration; existing writer approval integration. Never modify a migration that has already been applied.
- Create focused root tests under `test/`, conditionally registered from `test/rm-simple-place-workflows.test.js` for the repository’s disposable-PostgreSQL CI lane.
- Regenerate `supabase/schema.sql` only from the linked live catalog after governed migration application.

**Finance UI**
- Keep the `/admin/rate-rules` route and `RateRulesPage` entry point stable while changing the rendered page to Rate cards.
- Add focused components under `apps/web/src/components/rateCards/` for card navigation, version summary/history, grouped rates, draft editing, comparison, and approval.
- Add page-specific styles under `apps/web/src/pages/RateCardsPage.css`; retain shared tokens from `PageStyles.css`.
- Add focused unit tests beside the new components and retain/update `apps/web/src/pages/RateRulesPage.guard.test.ts`.

**Existing rate readers and writers**
- Update `apps/web/src/lib/placeServices.ts`, `apps/web/src/components/placeServices/ResponsibleRunDialog.tsx`, `apps/web/src/components/StaffPayRatesPanel.tsx`, `apps/web/src/pages/ClientSetupPage.tsx`, `apps/web/src/components/PriceListPicker.tsx`, `apps/web/src/pages/CRMPage.tsx`, `apps/web/src/components/CrmAccountWorkspace.tsx`, `apps/web/src/pages/DispatchConsolePage.tsx`, and `apps/web/src/components/FinanceLabourCostWorkspace.tsx` where they read, select, or create rates.
- Update `apps/web/src/shells/AdminShell.tsx`, cost-of-service links, and `apps/web/src/components/BobPanel.tsx` labels while preserving route compatibility.
- Keep `apps/web/src/components/PriceBookPanel.tsx` and `FinanceBureauPage.tsx` for materials, equipment inventory items, and discount reference plans; do not make those the source for hourly or kilometre charges.

## Implementation Tasks

### Task 1: Create cards, versions, lineage and safe legacy backfill

**Files:**
- Create: `supabase/migrations/20261118090000_rate_card_foundation.sql` (use a newly generated timestamp if occupied)
- Create: `test/versioned-rate-cards-migration.test.js`
- Create: `test/versioned-rate-cards-postgres.test.js`
- Modify: `test/rm-simple-place-workflows.test.js`

**Interfaces:**
- Produces `public.rate_cards`, `public.rate_card_versions`, `rate_rules.rate_card_version_id`, `rate_rules.rate_line_key`, and `rate_rules.rate_group`.
- `rate_cards` distinguishes charge and pay cards and stores `payroll_role_code` for role-specific pay cards.
- Adds `service_agreements.rate_card_id` for the agreement-selected card.
- Produces one active branch Standard card for charge rates and one Standard pay card, plus client cards grouped from existing client scopes. A client may have several cards, but at most one default.
- Preserves all existing `rate_rules.id` values, line-level effective dates, and inactive status during initial assignment.
- Produces a dry-run query/report for duplicate live rules and agreement commercial settings that differ from existing client rules. No ambiguous duplicate or differing agreement setting is silently merged.

- [ ] **Step 1: Write failing PostgreSQL assertions** for unique Standard cards, multiple client cards with one default, preservation of existing `rate_rules.id` and scopes, safe effective-date coverage, idempotent backfill, and a dry-run that reports the duplicated NZ Health/Health NZ rules and agreement-level differences.
- [ ] **Step 2: Run `node --test test/versioned-rate-cards-migration.test.js`** and confirm the test fails because the card schema and backfill are absent.
- [ ] **Step 3: Run Atlas preflight** for `rate_rules`, `resolve_rate_rule`, `service_agreements`, and `agreement_place_rate_selections`; cross-check the actual writer/readers in `supabase/schema.sql` before changing shared schema.
- [ ] **Step 4: Add the migration** with the card/version tables, constraints and indexes; preserve the rate rule IDs; assign each existing rule a fresh lineage key; derive `rate_group` from the existing service/job/rate type with an editable stored value; attach rules to a version 1 without collapsing line dates; and implement a read-only dry-run that lists duplicates and commercial-setting conflicts.
- [ ] **Step 5: Run disposable PostgreSQL tests** with `$env:BOB_TEST_POSTGRES='1'; node --test test/versioned-rate-cards-migration.test.js; Remove-Item Env:BOB_TEST_POSTGRES`; verify exact preservation and explicit conflict reporting.
- [ ] **Step 6: Commit the isolated schema/backfill slice** after the dry-run output is ready for owner review; do not apply the migration live until the conflict report is reviewed.

### Task 2: Govern draft creation, version approval and audit

**Files:**
- Create: `supabase/migrations/20261118100000_rate_card_version_lifecycle.sql` (use a newly generated timestamp if occupied)
- Create: `test/rate-card-approval-migration.test.js`
- Modify: `test/rm-simple-place-workflows.test.js`

**Interfaces:**
- Produces these governed RPCs:
  - `public.manage_rate_card(p_client_request_id uuid, p_action text, p_rate_card_id uuid, p_kind text, p_name text, p_client_organization_id uuid, p_is_client_default boolean, p_service_agreement_id uuid)` for card creation, default assignment, and agreement linkage.
  - `public.start_rate_card_version(p_client_request_id uuid, p_rate_card_id uuid, p_expected_version_id uuid)` to copy the approved version into an editable draft while preserving `rate_line_key`.
  - `public.manage_rate_card_draft_line(p_client_request_id uuid, p_version_id uuid, p_action text, p_rate_rule_id uuid, p_name text, p_rate_type text, p_amount numeric, p_rate_group text, p_scope jsonb, p_effective_from date, p_effective_to date, p_asset_id uuid)` for create/update/retire draft lines.
  - `public.submit_rate_card_version(p_client_request_id uuid, p_version_id uuid, p_effective_from date, p_change_note text, p_expected_updated_at timestamptz)` and `public.decide_rate_card_version(p_client_request_id uuid, p_version_id uuid, p_decision text, p_reason text, p_expected_updated_at timestamptz)` for submission, approval, or rejection.
- Finance access uses the repository’s operating-branch finance-admin check; no browser table writes.
- Every mutation is tenant-scoped, audit logged, idempotent, and protected against stale edits.
- One draft per card; approval dates cannot overlap the card’s previous version, and a new version cannot start on or before that previous version’s start date.
- A finance user may approve their own submission only if no other authorized finance user is available; record this exception in audit metadata.

- [ ] **Step 1: Write failing tests** named `requires_finance_for_decision`, `keeps_draft_prices_out_of_resolution`, `rejects_overlapping_or_non_monotonic_version_dates`, `copies_lineage_but_not_approved_mutability`, `makes_approval_atomic_and_idempotent`, `audits_lone_finance_self_approval`, and `groups_rates_with_explicit_override`.
- [ ] **Step 2: Run the focused Node/Postgres test** and verify expected failures against the current rule manager.
- [ ] **Step 3: Implement the RPCs and lifecycle constraints** in the migration. Reject direct edits to pricing columns on approved versions; allow changes only through a copied draft. Persist submitter, approver, decision reason, effective range, and request idempotency.
- [ ] **Step 4: Run `$env:BOB_TEST_POSTGRES='1'; node --test test/rate-card-approval-migration.test.js; Remove-Item Env:BOB_TEST_POSTGRES`**; verify unauthorized, stale, replayed, rejected, and approved transitions.
- [ ] **Step 5: Commit the lifecycle slice** after the SQL and audit tests pass.

### Task 3: Resolve approved cards and preserve existing pricing references

**Files:**
- Create: `supabase/migrations/20261118110000_rate_card_resolution.sql` (use a newly generated timestamp if occupied)
- Create: `test/rate-card-resolution-migration.test.js`
- Modify: `test/rm-simple-place-workflows.test.js`

**Interfaces:**
- Adds an agreement-aware overload of `public.resolve_rate_rule` with optional `p_service_agreement_id uuid`; retains the existing signature as a compatibility wrapper.
- Resolves approved version lines only for the work date: place override → agreement card → client default card → Standard. Within each card retain the current rule specificity, priority, effective-date and stable ordering.
- Resolves pay as staff-specific rule → payroll-role pay card → Standard pay card.
- Adds `rate_line_key` to selectable references (`agreement_place_rate_selections`, `service_agreement_delivery_schedules`, quote proposal module/scope schedule selections) while leaving transaction evidence pinned to its original `rate_rule_id`.
- Updates the response-rate RPC and resolver from the in-flight place response work so the response card reads and writes the agreement's card; the 30-minute minimum/increment remain agreement terms.
- Replaces each SQL reader that prices new work or previews current prices, including dispatch completion, patrol stop charge, timesheet pay/charge, quote preview/acceptance, readiness and cost-of-service functions. Preserve historical snapshots and already-priced line totals.
- Agreement-owned `base_rate_per_hour`, `callout_rate_per_hour`, and `travel_rate_per_km` are copied to the agreement’s card and thereafter displayed as card-derived; callout minimum and increment remain commercial terms.

- [ ] **Step 1: Write failing PostgreSQL tests** named `client_card_overrides_standard_per_matching_request`, `standard_fills_only_missing_client_lines`, `keeps_specificity_inside_each_card`, `agreement_cards_for_same_client_resolve_independently`, `place_lineage_follows_new_approved_version`, `priced_and_invoiced_lines_keep_old_rule_and_amount`, `pending_and_missing_rates_never_price_as_zero`, and `agreement_terms_migrate_without_duplicate_live_prices`.
- [ ] **Step 2: Run the focused PostgreSQL test** and confirm current single-list resolution or fixed `rate_rule_id` behavior fails the new assertions.
- [ ] **Step 3: Implement the resolver overload and compatibility wrapper**; identify SQL callers via `git grep` and replace them in this forward migration so all new work uses the agreed card precedence and the agreement when known.
- [ ] **Step 4: Add lineage-aware reads and writes** for selectable place, delivery schedule and quote selections; keep dispatch/pay/patrol charge evidence and accepted quote snapshots immutable.
- [ ] **Step 5: Add migration dry-run discrepancy output** for the last 90 days of priced work and recent quotes. Fail closed if unresolved differences remain; require owner acceptance or explicit migration correction before live apply.
- [ ] **Step 6: Run rate-resolution, place-billing, quote, patrol, dispatch and timesheet PostgreSQL tests** through the existing root test registration. Verify all changed amounts, references, approvals, and no-zero behavior.
- [ ] **Step 7: Commit resolver and price-reference changes** separately from the page.

### Task 4: Route all rate changes through finance approval

**Files:**
- Create: `supabase/migrations/20261118120000_rate_card_approval_entrypoints.sql` (use a newly generated timestamp if occupied; never edit an applied migration)
- Create: `test/rate-card-entrypoints-migration.test.js`
- Modify: `test/rm-simple-place-workflows.test.js`

**Interfaces:**
- `manage_operating_branch_rate_rule` and `manage_staff_pay_rate` keep their call signatures where possible, but create or update draft version lines and return pending-version state rather than a live rate.
- `apply_bob_rate_rule_proposal` creates a pending draft line and approval item; it does not activate a rate.
- The new card approval queue is the authoritative finance decision path for every authoring surface.
- New and changed rates show pending status until approval; deactivation/retirement of approved lines creates a draft version rather than mutating history.

- [ ] **Step 1: Write failing tests** for place-rate creation, staff-specific pay creation/review, Bob proposal application, replay after lost response, cross-tenant request denial, and prevention of active pricing before finance approval.
- [ ] **Step 2: Run the entrypoint PostgreSQL test** to verify current direct activation fails the expected assertions.
- [ ] **Step 3: Replace each writer through a forward migration** to stage draft card changes and return the approval status; keep the old public signatures compatible where clients already call them.
- [ ] **Step 4: Verify grants, `search_path`, RLS and audit** for finance decisions and service-role Bob execution. Revoke direct authenticated INSERT/UPDATE/DELETE from card/rule tables.
- [ ] **Step 5: Run the place-services, staff-pay and Bob proposal tests** in the disposable PostgreSQL lane; ensure failures are explicit and no success-shaped “rate added” response remains.
- [ ] **Step 6: Commit the entrypoint-governance slice** after focused tests pass.

### Task 5: Build the Rate cards workspace and approval UX

**Files:**
- Create: `apps/web/src/components/rateCards/RateCardNavigation.tsx`
- Create: `apps/web/src/components/rateCards/RateCardDetail.tsx`
- Create: `apps/web/src/components/rateCards/RateCardVersionDialog.tsx`
- Create: `apps/web/src/components/rateCards/rateCards.ts`
- Create: `apps/web/src/components/rateCards/rateCards.test.ts`
- Create: `apps/web/src/pages/RateCardsPage.css`
- Modify: `apps/web/src/pages/RateRulesPage.tsx`
- Modify: `apps/web/src/pages/RateRulesPage.guard.test.ts`
- Modify: `apps/web/src/shells/AdminShell.tsx`
- Modify: `apps/web/src/components/BobPanel.tsx`

**Interfaces:**
- Keep `/admin/rate-rules` and the `RateRulesPage` route component; display the page title **Rate cards**.
- Add tabs: **Client charges**, **Staff pay**, **Payroll setup**, and **Needs a rate**.
- Client/staff card selection shows approved version, effective range, agreements or role, grouped rates, Standard fallbacks, draft diff with old → new amount and percentage change, and version history.
- Agreement commercial settings include a governed card selector showing the client's default and other available cards; saving is explicit and the selection is visible in the agreement summary.
- Draft mutations call the governed RPCs from Task 2; only finance-authorized users can edit/submit/approve. Other authorized users see read-only cards and visible pending state.
- Equipment lines can link an `asset_id`; display cost and margin only from an approved `finance_asset_cost_profiles` record. Never infer asset cost from the retail price book.
- For an hourly equipment line, calculate unit cost as `(acquisition_cost + setup_cost - residual_value) / (productive_hours_per_year * useful_life_months / 12)`; for a per-km line use `(acquisition_cost + setup_cost - residual_value) / useful_life_km`. If the required denominator is missing or non-positive, show margin as unavailable, not zero.
- Move payroll codes, payroll readiness, discount bands and fuel panel into Payroll setup without removing or changing their underlying behavior.
- Keep finished dispatch jobs and unresolved patrol visits in Needs a rate; each action opens the relevant card/group with scope prefilled.

- [ ] **Step 1: Write failing Vitest tests** for client/staff tab switching, read-only permission, loading/error/empty states, draft diff and submission, finance approval/rejection, a missing-rate queue action, and equipment margin from approved cost only.
- [ ] **Step 2: Run `npx vitest run src/components/rateCards/rateCards.test.ts src/pages/RateRulesPage.guard.test.ts`** in `apps/web` and verify the feature is not present.
- [ ] **Step 3: Build the focused card components** using existing page tokens and controls; keep all labels visible, keyboard operation and focus return, inline errors, and explicit save/approval feedback.
- [ ] **Step 4: Recompose `RateRulesPage`** into the four tabs, preserving payroll setup, discount, fuel, completed-job and patrol-charge workflows with no duplicated screens.
- [ ] **Step 5: Update Finance navigation and Bob’s label** to Rate cards; retain old routes and useful deep links.
- [ ] **Step 6: Run focused Vitest and TypeScript checks** with `npx vitest run src/components/rateCards/rateCards.test.ts src/pages/RateRulesPage.guard.test.ts` and `npx tsc --noEmit -p tsconfig.json`.
- [ ] **Step 7: Commit the Rate cards UI slice** after all user-state tests pass.

### Task 6: Update consumers, place workflows and price pickers

**Files:**
- Modify: `apps/web/src/lib/placeServices.ts`
- Modify: `apps/web/src/components/placeServices/ResponsibleRunDialog.tsx`
- Modify: `apps/web/src/components/StaffPayRatesPanel.tsx`
- Modify: `apps/web/src/components/CrmAgreementCommercialTermsPanel.tsx`
- Modify: `apps/web/src/lib/commercialModel.ts`
- Modify: `apps/web/src/pages/ClientSetupPage.tsx`
- Modify: `apps/web/src/components/PriceListPicker.tsx`
- Modify: `apps/web/src/pages/CRMPage.tsx`
- Modify: `apps/web/src/components/CrmAccountWorkspace.tsx`
- Modify: `apps/web/src/pages/DispatchConsolePage.tsx`
- Modify: `apps/web/src/components/FinanceLabourCostWorkspace.tsx`
- Modify: related existing Vitest guard and component tests in those folders

**Interfaces:**
- Every picker lists only approved effective rates from the applicable card and identifies source/version; draft rates are visible as pending to authorized finance users but cannot price work. Add optional `serviceAgreementId?: string` and `clientOrganizationId?: string` to `PriceListPicker` so agreement-card selection precedes client default and Standard.
- Existing place selections and schedules use `rate_line_key` when selecting a rate, so an approved new version is followed on later work.
- Place and staff authoring flows show **Pending finance approval** after their governed RPC returns draft status; error and retry preserve the same request id.
- PriceListPicker combines the selected client’s approved card rates with the existing `finance_price_book` item list; preserve items, price snapshots and manual-entry behavior.
- Existing page routes and RPC call contracts remain usable through compatibility wrappers.

- [ ] **Step 1: Write failing component/guard tests** showing each reader excludes draft versions, source/version labels are present, repeated selection follows lineage, and place/staff creation reports pending rather than active.
- [ ] **Step 2: Run targeted Vitest tests** for `placeServices`, `ResponsibleRunDialog`, `StaffPayRatesPanel`, `PriceListPicker`, CRM/client setup, dispatch and labour cost.
- [ ] **Step 3: Implement approved-card query helpers** and change the listed components to use them; keep access control and provider/client scope enforced by the RPC/RLS path.
- [ ] **Step 4: Add stale-card and pending states** to place and HR screens; do not let an unsaved or unapproved selection appear as live pricing.
- [ ] **Step 5: Run focused Vitest and TypeScript checks**; verify materials/equipment inventory still comes from `finance_price_book`, and hourly/per-km prices come from cards.
- [ ] **Step 6: Commit the consumer migration** after all relevant focused tests pass.

### Task 7: End-to-end acceptance, canon review and release evidence

**Files:**
- Create: `apps/web/e2e/rate-cards.spec.ts`
- Modify: `docs/canon/ORG_SERVICE_MODEL.md` if card-to-agreement ownership needs to be recorded as a durable commercial-model ruling
- Update Atlas only through its generated refresh path after the schema snapshot changes

**Interfaces:**
- Acceptance covers an admin finance user, a read-only role, a client with two agreement cards, a client using its default, a place-specific override, and a card with a missing line falling back to Standard.
- A user can create a draft, compare it with the approved version, submit it, receive approval as a finance user, and see the new effective price only for future work.
- A pre-existing invoice/charge line and accepted quote remain unchanged.

- [ ] **Step 1: Add Playwright flows** for desktop and narrow viewport: browse cards, compare/submit/approve a version, verify pending and permission states, open Needs a rate, and confirm material items remain on Prices & discounts.
- [ ] **Step 2: Run `$env:E2E_OFFLINE='1'; npx playwright test e2e/rate-cards.spec.ts; Remove-Item Env:E2E_OFFLINE`** from `apps/web`; verify no horizontal overflow and keyboard access through card selection and approval.
- [ ] **Step 3: Run canon-conformance and UX-state reviews**; address findings on agreement ownership, immutability, complete UI states and real data wiring.
- [ ] **Step 4: Run the complete root Node test suite, focused PostgreSQL migration set, web Vitest suite, TypeScript check and production build.** Report unrelated baseline failures by name rather than hiding them.
- [ ] **Step 5: Review the final migration dry-run output** with the owner; do not silently merge the duplicate NZ Health and Health NZ rates or any agreement-level commercial conflicts.
- [ ] **Step 6: Prepare the signed PR and release evidence** using the verified GitHub identity and protected PR path. Do not apply a live migration until the dry-run conflicts have owner disposition; after governed application regenerate `schema.sql`, refresh Atlas, and verify resolver output read-only.

## Execution Order and Boundaries

The sequence is intentionally vertical: schema and dry-run → governed lifecycle → resolution → all authoring paths → card UI → consumer updates → acceptance. Do not ship a UI that implies cards are the source while existing readers or writers bypass approval. Each task is separately reviewable, but Tasks 1–4 form the data-safety gate and Tasks 5–7 cannot claim completion without them.

The PostgreSQL migration test harness uses `BOB_TEST_POSTGRES=1` and conditional registration from the existing CI-listed root test entry. Live migration application, schema snapshot refresh, Atlas refresh, and release are separate governed operations after tests and owner review.
