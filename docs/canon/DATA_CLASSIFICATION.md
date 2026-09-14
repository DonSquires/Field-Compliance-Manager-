> **Canonical copy.** Origin: GitLab `don-squires1/field-compliance-manager` `` @ `Main`, read 2026-09-14 via `scripts/gitlab-read.mjs`. This repository (`DonSquires/Field-Compliance-Manager-` `main`) is the authoritative home from now on; the GitLab text is lineage. Edit here and record the ruling — never fork the text. Links to files that do not exist in this repo refer to that lineage.

# DATA CLASSIFICATION

> **Status: OPERATIONAL DOCTRINE — PENDING LEGAL CONFIRMATION.** A sound reading
> of what counts as personal / sensitive information under the NZ Privacy Act
> 2020; NOT a ratified legal position. Classification of personal/sensitive
> information is legal/privacy-critical (per `FOUNDATION.md`). Confirm against
> legislation.govt.nz, the Office of the Privacy Commissioner, and counsel before
> treating any part as compliance-binding.
>
> Derives from `FOUNDATION.md`. Sibling to `docs/ACCESS_DOCTRINE.md`,
> `docs/ACCESS_MODEL.md`, `docs/RETENTION_DOCTRINE.md`. The shared vocabulary
> those doctrines consume when they ask "what kind of information is this?"
>
> **Strict boundary (owner + Bob ruling on !1216):** this document MAPS and
> RECONCILES the classification vocabularies. It does NOT imply that document
> classification already enforces operational fact-table access. Live verification
> (2026-08-01) confirmed NO Atlas edge targets `privacy_class` from any
> fact-table read path — the document classifier is document-only today.

## The seam line (verbatim, owner+Bob)

> **"This classification vocabulary is shared across doctrine now; its use in
> operational access decisions remains future work until explicitly wired into
> live fact-table entitlement paths."**

## Why this exists (the shared floor under access + retention)

Access (`ACCESS_MODEL.md`) and retention (`RETENTION_DOCTRINE.md`) both need to
know, for any record, WHAT KIND of information it is:
- Access uses it for `sensitivity_mode` (informative vs quiet) and the
  operational-vs-narrative content boundary — **as an intended future input,
  not a present control** (see §Future seam).
- Retention uses it to know whether IPP 9 (personal-information retention limit)
  applies to a record at all.

So classification is the shared vocabulary beneath both. One source, referenced
twice, never forked.

## The anchor test (what makes information PERSONAL)

**Not "does a name appear."** The test is: **could a person be recognised from
it — directly, or by combining it with other information reasonably available,
including what the app already holds?** This app is a linking machine (plates,
GPS traces, checkpoint scans, shift patterns); a data point that is innocuous
alone becomes personal the moment it links to a person. Treat it as personal if
a staff member could reasonably work out who the person is from the record itself
or by combining it with what the app already knows.

It can still be personal information even if: it is true OR false; public
elsewhere; not collected directly from the person; only one small data point that
helps identify them.

## The three tiers

1. **Operational metadata** — not about an identifiable person on its own.
   E.g. client org name, generic site address, patrol frequency, zone boundaries,
   checkpoint locations, service instructions, properly anonymised data.
2. **Personal information** — about an identifiable person, directly or by linkage.
   E.g. names/contacts/DOB/address; staff-linked traces (staff ID, call sign,
   shift/dispatch history, GPS trace, checkpoint scans, radio/PTT logs, device
   IDs) when they point to an officer; complainant/witness/occupier/vehicle-owner
   details; images/recordings where a person is identifiable; narrative records
   (patrol logs, incident reports, compliance evidence, officer notes); opinions
   about a person even if informal/mistaken/unproven.
3. **Sensitive personal information** — the heightened-protection subset.
   E.g. health, complaints, allegations, welfare concerns, disciplinary matters,
   criminal/enforcement information. (Homeless status is sensitive — per the
   `privacy_act_entity_intelligence` doctrine.)

**Naming discipline (resolving the tripled "sensitive"):** in THIS document,
"sensitive" means TIER 3 (**sensitive personal information**). It is distinct
from the document-layer label `tenant_sensitive` (a handling label, see mapping)
and from informal uses like "homeless status is sensitive" (an instance of
tier 3). When precision matters, say "tier-3 / sensitive-personal."

## Mapping onto the existing document vocabulary (MAP, do not supersede)

The document registry (`document_classifications.privacy_class`, migration 0316)
already uses `public | internal_non_sensitive | tenant_sensitive | restricted`,
live and enforcing DOCUMENT promotion/retrieval (NOT fact-table access). The
three tiers sit ABOVE that enum as the unifying privacy classifier; the enum
remains the document-layer expression. Do NOT supersede it.

| Privacy tier (this doc) | Maps to document `privacy_class` | Note |
|---|---|---|
| operational metadata | `internal_non_sensitive` | not personal on its own |
| personal information | `tenant_sensitive` | identifiable, directly or by linkage |
| sensitive personal information | `restricted` | tier-3 heightened protection |
| (n/a — handling state) | `public` | a publication/handling state, NOT a privacy tier |

The four orthogonal document flags (`contains_pii`, `contains_operational_security`,
`contains_financial_data`, `contains_legal_privilege`) are MARKERS that already
drive document promotion rules; they compose alongside the tier, they do not
replace it.

A separate HANDLING-SCOPE vocabulary also exists (`documents.current_scope`:
`conversation_only | tenant_reference | global_reference | quarantined`). Scope
is REACH, not privacy — orthogonal to the tiers.

## Grounding for the operational side (the entity-intelligence doctrine)

The fact-table PII doctrine already lives in the `privacy_act_entity_intelligence`
knowledge card (0113), IPP-grounded: substantive PII is org-owned + org-scoped;
cross-org reads audit-logged (IPP 6); retention via `retention_policies` (IPP 9);
use/disclosure limits (IPP 10/11); homeless status sensitive; redact PII before
any external/AI call. The three tiers are the shared NAMES for what that card
already governs operationally. This document RECONCILES the names; it does not
change that card's live behaviour.

## Future seam — operational use is planned wiring, NOT present control

- **Today:** the document classifier is document-only. Live verification
  (2026-08-01, Bob's console) found NO Atlas edge targeting `privacy_class` from
  any fact-table read path. No operational access decision consults a classifier.
  Evidential home: `docs/proposals/ATLAS_VERIFIED_REANCHOR_WORKLIST.md` (!1217),
  §"Residuals — live-confirmed", check (b) — where this finding is recorded with
  the other two live-confirmed keystone residuals.
- **Intended future input:** `ACCESS_MODEL.md` carries an empty slot —
  `sensitivity_mode` (informative | quiet) and the operational/narrative content
  boundary — that is a **planned reconciliation point** for these tiers. WHEN
  WIRED, tier-3 (sensitive-personal) would be the intended input that selects
  `quiet` mode, and the operational/personal split would be the intended input
  for the content boundary.
- **Discipline:** until that wiring exists in live fact-table entitlement paths,
  no present-tense claim is made that classification determines or drives
  operational access. It does not, today.

## Consumers (shared doctrine only — not evidence of live enforcement)

- `ACCESS_MODEL.md` — references these tiers as the INTENDED FUTURE INPUT to
  `sensitivity_mode` and the content boundary. Not wired today.
- `RETENTION_DOCTRINE.md` — references personal / sensitive-personal to know when
  IPP 9 retention applies.

## Deferred (needs legal grounding)

- Confirmation of the tier definitions and the personal/sensitive boundary
  against NZ statute + Privacy Commissioner guidance + counsel.
- The category schedule (which record types fall in which tier by default) —
  aligns with the retention schedule, also deferred.

## History trace

Owner definition of personal/sensitive information (re-identification-by-
combination test) + Bob's !1216 ruling (map, do not supersede; describe, do not
over-claim; future seam not present control), 2026-08-01. Reconciliation
groundwork: `docs/proposals/RECON_classification_vocabularies.md`. Live seam
verification: Bob console (no `privacy_class` fact-table edge). Pending legal
confirmation. Authors: Bob (NZ-law grounding + ruling), Don Squires (the
identifiability test), Jim (drafting to the ruling).