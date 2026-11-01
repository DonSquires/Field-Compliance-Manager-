> **Canonical copy.** Origin: GitLab `don-squires1/field-compliance-manager` `` @ `Main`, read 2026-09-14 via `scripts/gitlab-read.mjs`. This repository (`DonSquires/Field-Compliance-Manager-` `main`) is the authoritative home from now on; the GitLab text is lineage. Edit here and record the ruling — never fork the text. Links to files that do not exist in this repo refer to that lineage.

# RETENTION DOCTRINE

> **Status: OPERATIONAL DOCTRINE — PENDING LEGAL CONFIRMATION.** This is a sound
> internal reading of NZ Privacy Act 2020 Information Privacy Principle 9 (IPP 9,
> retention limitation). It is NOT a ratified legal position. Retention is a
> legal / privacy-critical matter (per `FOUNDATION.md`: do not finalise such
> matters on our own judgment). Confirm against legislation.govt.nz, the Office
> of the Privacy Commissioner, and legal counsel before treating any part as
> compliance-binding. Category-specific periods (the schedule) are DEFERRED until
> legally grounded.
>
> Derives from `FOUNDATION.md`. Sibling to `docs/ACCESS_DOCTRINE.md` and
> `docs/ACCESS_MODEL.md`.

## Why this is a separate doctrine (shared grammar, different question)

Access and retention share a **state-based, purpose-tied grammar** — both expire
on the end of a reason, not the tick of a clock — but they answer DIFFERENT
questions, so they live in DIFFERENT files:

- **Access** (`ACCESS_MODEL.md`): *who may see this record now?* — granted while a
  live BASIS exists.
- **Retention** (this doc): *should this record still exist now?* — kept while a
  live PURPOSE exists.

Keeping them separate avoids merging adjacent ideas because they rhyme, and lets
counsel sign off retention without reopening the access model.

## Anchor rule

**Retain personal information only while a live lawful purpose exists** — the
purpose it was collected for, or another lawful purpose that has since arisen.
(IPP 9: do not keep personal information for longer than required for the purpose
it may lawfully be used.)

## Expiry rule

**When no live lawful purpose remains, delete or de-identify** — as soon as
reasonably practicable. "Might be useful later" is NOT a lawful purpose.

## The three states

1. **Active matter** → **retain**.
2. **Closed but still challengeable** (appeal / dispute / production window open)
   → **retain**.
3. **Closed and no live purpose remains** → **delete or anonymise**.

State-based, not date-only. (Mirrors the access model's basis-lifecycle: the
record's existence expires on the end of purpose, exactly as access expires on
the end of basis.)

## Live-purpose exceptions (reasons that KEEP a record alive)

A record stays retained while ANY of these is live:
- active complaint, dispute, prosecution, appeal, or investigation
- a contractual or statutory record-keeping obligation
- court discovery or lawful production (see `ACCESS_MODEL.md` R3 `lawful_production`)
- evidential continuity for enforcement or incident records
- a genuine health & safety need
- an open challenge / limitation window

The "court-ready, we never know what string may be pulled" need is satisfied HERE
— the challenge window and evidential continuity are live purposes. It does NOT
justify indefinite retention once every purpose is genuinely dead.

## Used vs unused (the sharp distinction)

- **Used for a real purpose** → retain while that purpose lives.
- **Collected but never needed for any real purpose** → dispose PROMPTLY unless a
  separate lawful purpose appears. Data held "just in case" is weak under IPP 9.
  (E.g. an observation that never fed an enforcement action; a scan that matched
  nothing; a photo on a job that closed clean — these do not get to linger.)

## Relationship to access (do not conflate)

- A retained record's VISIBILITY is governed separately by `ACCESS_MODEL.md`
  (live basis + place + task). Retention says the record may EXIST; access says
  who may SEE it.
- A record may be retained (a live purpose exists) while NO ONE currently has an
  access basis to read it — that is correct, not a contradiction. The custodian
  preserves it; access is granted only on a live basis when one arises.

## Configuration

Per-council / per-module implementation belongs in the existing `retention_policies`
table ("per-council, optional per-module evidence retention periods; configurable,
not hardcoded"). The DOCTRINE is universal; the PERIODS are configured per
instrument (RMA, Freedom Camping Act, LGA, council bylaw) and MUST be legally
grounded before they are set.

## The staff rule (say it aloud)

> **"What is the live reason for keeping this — and does that reason still exist?
> If yes, keep it. If no, delete it or de-identify it."**

The field companion to the Three-Question Access Test. What a good officer does on
the doorstep for disclosure, they do for retention too.

## Deferred (needs legal grounding before ratifying)

- The category-by-category RETENTION SCHEDULE: patrol logs, evidence photos,
  incident reports, dispatch records, compliance/enforcement evidence — each
  mapped to its live-purpose end-state and any statutory floor. NOT frozen here;
  each period must trace to a known obligation and legal confirmation.
- **NZTA register information (owner ruling 2026-11-01: report only).** The
  section 241 terms expect lookup records to be kept for at least 18 months and
  register-derived personal information not to be kept longer than needed. The
  annual summary (`get_nzta_s241_summary`) counts NZTA checks, lookups and
  reveals older than 18 months, 2 years and 5 years so an administrator can
  decide. Nothing is deleted or de-identified automatically until the schedule
  above is ratified.

## History trace

Owner reading of IPP 9 (state-based, purpose-tied), 2026-08-01. Prompted while
drafting the access-model retention clause — the owner correctly stopped an
"indefinite preservation" line before it was written, because indefinite
retention of personal data can itself breach IPP 9. Recorded as doctrine pending
legal confirmation. Authors: Don Squires (IPP 9 reading), Bob (separate-file
discipline), Jim (drafting). Access build proceeds independently.