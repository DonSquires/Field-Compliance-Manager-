# Bob Automation, Geofence, and Module Testing

Bob's human testing must verify automation as a governed workflow, not assume that a button or module implies automation exists.

## Required flow

### Before

Verify the expected configuration and preconditions:

- Organization, branch, agreement, site, and zone context.
- Enabled module and module rules.
- SLA, client-submission, and `allows_auto_dispatch` settings.
- Staff entitlement, direct grant, credential/readiness state.
- Boundary source, verification state, schedule, closure, and jurisdiction.
- Whether the expected automation should be present, absent, or blocked.

### During

Perform the human action and inspect:

- Visible controls and labels.
- Geofence point resolution and matched site/zone/module.
- Effective rules, access mode, closure, schedule, SLA, and jurisdiction.
- Requests/RPCs, loading state, permission checks, and error handling.
- Whether an automatic action is offered only when configuration permits it.

### After

Verify:

- The resolved decision is visible and understandable.
- The next safe action is clear: auto-dispatch, manual review, officer action, or blocked state.
- Any write has a receipt, audit event, and live read-back.
- Downstream dispatch, roster, evidence, notification, and report views agree.
- Disabled or unentitled modules remain absent and cannot be reached through the UI.

## Expected versus present

Bob must write the matrix explicitly:

```text
Expected: static_guarding enabled, auto-dispatch disabled, verified runtime zone.
Present:  static_guarding enabled, auto-dispatch disabled, point resolved to zone.
Missing:  explicit UI explanation if the disabled automation is not visible.
Contradiction: any control offers automation despite the agreement/module rule.
```

A missing automation is not automatically a defect. It may be intentionally disabled by agreement, module, closure, role, credential, or safety policy. Bob should question the intent, explain the tradeoff, and offer alternatives before filing an issue.

## Automated walkthrough

```bash
cd apps/web
npx playwright test e2e/dr-bob-automation-geofence-module.spec.ts
```

The walkthrough is fixture-backed and safe: it does not create dispatch work or submit enforcement actions. It checks the visual geofence decision, module entitlement boundary, and the expected automation boundary.
