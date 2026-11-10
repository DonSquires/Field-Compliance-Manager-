---
name: human-test-report
description: Turn a human-test observation into a redacted Before/During/After evidence packet and, only with confirmation, a deduplicated GitHub issue. Run it explicitly with /human-test-report <short description>.
disable-model-invocation: true
---

# Human-test report: $ARGUMENTS

Follow `docs/HUMAN_TESTING.md`, `docs/BOB_ISSUE_TRIAGE.md` and `docs/BOB_CREDENTIAL_BOUNDARIES.md`.
Never log in as a real user; use dedicated test identities or the human's own reproduction.

1. **Observation.** Who (role, organisation type - not a name), where (route, device), what they did,
   what they expected and what they saw. Ask whether a flagged design choice is intentional before
   calling it a defect.
2. **Expected vs present, in three stages.**
   - Before: preconditions, permissions, source records, configuration, route context.
   - During: controls, requests/RPCs, loading and error states, policy checks, writes, audit events.
   - After: persisted records, receipts, derived status, notifications, downstream screens, reports,
     and what the next actor sees.
3. **Trace.** Run `atlas-preflight` on the smallest changed node; check `supabase/schema.sql`; do a
   scoped, read-only live check only if needed. State present, absent and contradictory evidence.
4. **Redact.** Remove names, contact details, credentials, GPS, legal, HR, financial and security values.
   Record credential classes only, never values.
5. **Deduplicate.** `gh issue list --state all --search "<key words>"`; link an existing issue rather
   than opening a new one.
6. **Decide.** Only a reproducible, actionable defect becomes an issue. Show the drafted issue and ask
   for confirmation before `gh issue create`. Warnings and unconfirmed hypotheses stay in the report.
7. **Output** the packet: summary, environment, steps, Before/During/After table (expected | present),
   evidence (commands, receipts, screenshots), Atlas/schema trace, smallest next check, issue URL or
   "not filed" with the reason.
