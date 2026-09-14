> **Canonical copy.** Origin: GitLab `don-squires1/field-compliance-manager` `` @ `Main`, read 2026-09-14 via `scripts/gitlab-read.mjs`. This repository (`DonSquires/Field-Compliance-Manager-` `main`) is the authoritative home from now on; the GitLab text is lineage. Edit here and record the ruling — never fork the text. Links to files that do not exist in this repo refer to that lineage.

# Marlborough District Council RFIP 26-007 - source-of-record provenance

Faithful requirements SUMMARY of a confidential customer procurement document
(Marlborough District Council Request for Information and Pricing, Contract
26-007, Security & Other Services, issued 24 March 2026). The full RFIP is a
confidential customer document and is deliberately NOT reproduced verbatim here -
this summary preserves the operational requirements and provenance only.

## What this document is

This is the originating SEED document for the Marlborough smoke-complaint and
biosecurity module builds (and a cash-security module that was started for it and
stopped). It is recorded as provenance so future work can trace WHY those modules
exist and WHAT the customer actually asked for - because the schema is an
implementation of the contract, not the source of truth for the contract.

## Generalisation rule (load-bearing)

The originating contract SEEDED these modules; it does NOT define their limits.
Every module in this app is built from a specific real contract or job, but is
designed to GENERALISE across multiple councils and requirements. Modules must
NOT be hard-wired to Marlborough's exact wording. The contract is the seed, not
the cage.

Module -> originating seed (provenance map):
- Freedom camping <- LINZ contract
- Noise control <- Nelson City Council contract
- Smoke complaints + biosecurity <- Marlborough District Council RFIP 26-007 (this doc)
- Cash security <- started for Marlborough 26-007 (section 6), STOPPED
- Patrol / static guarding <- regular jobs; built for better reporting/process

## Services requested in 26-007 (seven)

1. Noise control (24/7 attendance, subjective assessment to council guidelines).
2. Smoke complaints (out of hours: 5pm-8am weekdays, 24/7 weekends/holidays;
   within the Marlborough air shed; subjective assessment).
3. Security patrol - parks/reserves (nightly, named sites).
4. Security patrol - council assets (carparks, libraries, MDC building).
5. Security - ad hoc events.
6. Cash security collection (BNZ Blenheim; weekly secured collection). [module
   started then STOPPED]
7. Biosecurity machinery inspections for Chilean Needlegrass.

## Biosecurity nuance (the part that drives slice 2)

Marlborough's biosecurity service is Chilean Needlegrass (Nassella neesiana)
MACHINERY INSPECTIONS: inspect earth-moving machinery to confirm it is cleaned,
clear of organic material, and fit for transport. On a FAILED inspection the
council must be told, distinctly:
- WHERE THE INSPECTION WAS UNDERTAKEN (the observed place), and
- THE PROPERTY THE OPERATOR WAS WORKING ON (the threatened land).

So the customer itself distinguishes the OBSERVED PLACE from the THREATENED LAND.
Inspections are organised into regional zones (Zone 1 Blenheim/Seddon Bridge,
Zone 2 Seddon/Ward, Zone 3 Ward).

## Architecture consequences (ratified)

- **Write-contract slice 2 direction (ratified):** biosecurity gets a DUAL-PLACE
  harmed/protected-party anchor - a protected/threatened-LAND anchor distinct
  from the observed place, named neutrally: **`protected_land_site_id`** (FK
  client_sites) + **`protected_land_address`**. NOT `complainant_*` (a complainant
  is a reporting channel; the accountability anchor in biosecurity is the land).
  The two places may be the same, different, or the threatened-land anchor may be
  unknown-yet (nullable). Tracked in `docs/design/WRITE_CONTRACT_SLICE2_BIOSECURITY.md`.
- **Explicit deferral - machinery-inspection workflow gap:** the current
  `biosecurity_assessments` table models a species/field assessment (species,
  density, seed-head, site). It does NOT model the machinery-inspection workflow
  (contractor/operator, machine identity, fit-for-transport pass/fail,
  property-worked-on). This is a REAL, GENERALISED gap (any council doing
  vector-transfer / contamination-control checks needs it), but it is a SEPARATE
  future item with its OWN write contract - NOT part of slice 2. Do not smuggle
  machinery-inspection modelling into the harmed-party anchor migration.

## Status

Provenance / source-of-record only. No behaviour. Confidential customer document
summarised, not reproduced.
