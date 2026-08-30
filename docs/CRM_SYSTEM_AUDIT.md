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
- Contact maintenance is governed by `manage_crm_contact`. Provider account
  teams are authorized through child-account hierarchy or an accepted service
  agreement. Create retries are stable, edits are expected-state checked,
  deactivation preserves history, and primary/emergency roles are explicit.
- `crm_account_activities` is the append-only human relationship timeline.
  Calls, emails, meetings, notes, tasks, outcomes, and follow-up dates are
  written through `create_crm_account_activity` with stable request identity.
- Existing invoice headers are operational in Accounts Receivable through
  `manage_crm_invoice`. Send, mark-paid, and void transitions are locked,
  state-valid, and audited. Direct browser mutation of contacts, activity, and
  invoices is revoked.

## Present but not active in CRM

- Quote-line edit/delete is not exposed. Adding a mistaken line currently requires
  a separate governed correction workflow.
- Invoice generation remains intentionally unavailable. The current schema has
  invoice headers but no invoice-line or payment-allocation entity, so a
  defensible amount cannot yet be generated from billing evidence.
- Payment reconciliation is currently a controlled mark-paid transition, not a
  bank-feed allocation workflow.
- Tenders and rate-rule administration remain outside active CRM.

## Atlas correction

The managed refresh now recognizes formatted multiline Supabase chains and
retires stale edges only when they are live `ci_generator` rows from the exact
managed source file. It never retires `manual_seed`, `schema_fk`, or unrelated
source evidence. The refresh moved old CRMPage invoice/contact/agreement write
claims to `legacy`. Active terrain now includes the shared account workspace,
relationship activity, invoice reads, and governed contact/activity/invoice RPCs.

## Recommended order

1. Add governed quote-line correction while preserving immutable audit history.
2. Add invoice lines and generation from accepted agreement/rate evidence.
3. Add payment allocation and bank reconciliation.
4. Add account ownership, task completion, and pipeline forecasting.