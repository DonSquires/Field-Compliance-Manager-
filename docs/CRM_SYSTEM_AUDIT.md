# CRM System Audit

Verified 2026-08-30 against `supabase/schema.sql`, active AdminShell routing,
source-derived Atlas edges, and live catalog privileges.

## Active CRM workflow

- Account truth is `organizations`; people are `crm_contacts` attached to an
  account. `CRMPage` batch-reads organizations, sites, primary contacts, quotes,
  and service agreements.
- Draft quote creation is governed by `create_crm_draft_quote`. Provider identity
  is derived from `auth.uid()`, counterparties are bounded, retries are stable,
  and direct quote-row mutation is revoked.
- Quote pricing is governed by `add_crm_quote_line`. It locks/race-checks a draft,
  validates client site/module dimensions, keeps provider cost distinct from
  client charge, recalculates discount/GST/totals, audits, and is retry-safe.
- Direct authenticated quote-line mutation is revoked.
- Quote send/accept/decline is governed by `manage_crm_quote`. Send rechecks
  labour pricing, positive totals, validity, and achieved margin. Acceptance is
  sent-only and is the sole authenticated gateway to `accept_quote`; decline
  requires a retained reason. All transitions are expected-state locked/audited.

## Present but not active in CRM

- Quote-line edit/delete is not exposed. Adding a mistaken line currently requires
  a separate governed correction workflow.
- Invoicing, payments, tenders, rate rules, and generate-invoice remain type names
  in legacy `CRMTab`; AdminShell does not route them through CRM.
- RelationshipWorkspace reads service agreements but does not mutate them.
- CRM contact maintenance is not exposed by active CRM; existing table policies
  and any dormant writers need a separate lifecycle review before activation.

## Atlas correction

The managed refresh now recognizes formatted multiline Supabase chains and
retires stale edges only when they are live `ci_generator` rows from the exact
managed source file. It never retires `manual_seed`, `schema_fk`, or unrelated
source evidence. The refresh moved old CRMPage invoice/contact/agreement write
claims to `legacy`; active CRMPage terrain is limited to its real reads and two
governed RPC calls.

## Recommended order

1. Add governed quote-line correction while preserving immutable audit history.
2. Build invoice generation from accepted agreement/rate evidence.
3. Add payment allocation/reconciliation.
4. Add governed contact lifecycle and account activity timeline.