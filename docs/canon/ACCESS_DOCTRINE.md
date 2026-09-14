> **Canonical copy.** Origin: GitLab `don-squires1/field-compliance-manager` `` @ `Main`, read 2026-09-14 via `scripts/gitlab-read.mjs`. This repository (`DonSquires/Field-Compliance-Manager-` `main`) is the authoritative home from now on; the GitLab text is lineage. Edit here and record the ruling — never fork the text. Links to files that do not exist in this repo refer to that lineage.

# THE THREE-QUESTION ACCESS TEST

> Derives from `FOUNDATION.md`. This is the access doctrine for the whole app.
> Every RLS decision on a sensitive/accountability record composes from it.
> Owner-authored (field training rule, ratified 2026-08-01).

## The test

Before any user sees a sensitive record, three questions must ALL be yes:

1. **Authorised** — is the person authorised to receive this information?
2. **Needs** — do they actually need it?
3. **Role** — is it required for their job / role?

This is the rule the owner trains field staff to apply before disclosing
information. It is now also the rule the SCHEMA applies. What a good officer
does on the doorstep, RLS does at the row.

## How it maps to the machinery (already live)

| Question | Enforced by |
|---|---|
| Authorised | `has_location_access(site, zone, direction)` (0261) — ownership of the place OR an active service agreement. Never org equality. |
| Needs + Role | The functional-area × level access layer — `staff_area_grants`, access presets (`preset_assignments`), role gates. |

**Composition rule for a sensitive-record SELECT:**

```
visible  =  operator_custody (preserved org_access_allowed gate)
         OR ( authorised_at_place  AND  needs_and_role_permits )
```

The operator keeps CUSTODY via the preserved gate (FOUNDATION: custodian, not
owner). The harmed party / any other reader gains access ONLY when all three
questions pass. Confidentiality holds at the DATA layer because a party who
fails question 1 (authorised) never sees the row — e.g. an offender never sees
the complainant's identity, because they are not authorised to.

## The executable layer

This document is the **principle layer** — compact and stable. The full composed,
ratified specification (standing authority vs situational entitlement, the two
place gates, the six task signals, geofence composition, the R1–R4 exception
rulings, the return-shape contract, and the 13-scenario test oracle) lives in:

> **`docs/ACCESS_MODEL.md` — the ratified executable doctrine and implementation/
> test contract.**

When this doctrine and the model must both be consulted, the doctrine states WHY
and the top-level rule; the model states HOW, in enforceable detail.

## Scope

Universal, like the anchor rule. Applies to every module and every future access
decision. Conformance is staged; the doctrine is not.
