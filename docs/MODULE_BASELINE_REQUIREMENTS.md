# Enterprise Field Compliance Manager — Module Baseline Requirements

Date: 2026-09-03
Status: Authoritative Platform Baseline Requirements

This document codifies the foundational module requirements, procurement seeds, legal invariants, and architectural constraints that form the base of the Field Compliance Manager platform.

All modules in this multi-tenant, enterprise SaaS platform originate from real customer procurement contracts or statutory mandates, but are designed to **generalize across any council, government agency, or commercial provider in New Zealand**.

---

## 1. Origination & Procurement Baseline

| Module Key | Originating Procurement Seed | Primary Legal / Regulatory Basis | Key Operational Constraint |
| --- | --- | --- | --- |
| `freedom_camping` | **LINZ Freedom Camping Contract** (Otago, Lake Dunstan, Lowburn, etc.) | Freedom Camping Act 2011 & Self-Contained Motor Vehicles Legislation Act 2023 | **2-Scan Overnight Invariant** (Evening + Morning scan at same site/zone = `verified_overnight`). |
| `parking_enforcement` | **MDC Parking Contract 10111** (Blenheim & Picton CBD) | Land Transport Act 1998 s.128E (Warranted Parking Wardens) & Local Bylaws | Event-driven ferry enforcement windows (30m pre/post arrival/departure) + Pay-by-Plate meter zones. |
| `biosecurity` | **MDC RFIP 26-007** (Section 7) | Biosecurity Act 1993 (Chilean Needlegrass / *Nassella neesiana*) | **Dual-Place Accountability** (Observed Source Place $\neq$ Protected/Threatened Land). |
| `noise_control` | **Nelson City Council Contract** + MDC RFIP 26-007 | Resource Management Act 1991 s.326 (Abatement Notice) & s.327 (Excessive Noise Direction / Seizure) | **6-Step Assessment Workflow** + TDC 3-Axis Matrix (Volume + Time + Tone $\ge 5$). |
| `smoke_complaints` | **MDC RFIP 26-007** (Section 2) | Resource Management Act 1991 & Marlborough Air Shed Bylaws | Out-of-hours coverage (5:00 PM – 8:00 AM weekdays, 24/7 weekends/holidays). Subjective & photo assessment. |
| `welfare_check` / `safety` | Core Platform Infrastructure | Health & Safety at Work Act 2015 | 2-minute GPS heartbeat, confirmed check-ins, active SOS, and server-backed Oracle truth evaluation. |
| `static_guarding` & `patrol` | Standard Commercial Contracts | Private Security Personnel and Offence Victims Act 2008 | Shared Assignment construct: **1-stop = Static Guarding**, **N-stops = Patrol Route**. |

---

## 2. Core Architectural Invariants

### 1. Generalization Rule (Load-Bearing)
Modules are seeded by specific council contracts (e.g., MDC, Nelson, LINZ), but **schema, RPCs, Edge Functions, and client interfaces must NEVER be hard-wired to specific council wording or local brand names**. Every module must accept configurable rule sets via `module_rule_sets`, `noise_module_config`, `parking_module_config`, and `freedom_camping_org_settings`.

### 2. Governed Command Pattern (No Direct Client Table Mutating)
Mobile and web applications must call governed Edge Functions or SECURITY DEFINER RPCs (e.g., `submit-biosecurity-assessment`, `submit_officer_field_report`, `process-officer-scan`) rather than performing direct `insert()` or `update()` calls on raw database tables followed by separate unconfirmed Edge Function calls. Every transaction must atomically write:
1. The domain fact record.
2. Linked evidence items / storage pointers.
3. An append-only audit log entry (`audit_log`).
4. A durable `officer_command_requests` idempotency receipt.

### 3. Dual-Place Accountability (Source vs. Harmed/Protected Land)
For environmental and compliance modules (`biosecurity`, `noise_control`, `smoke_complaints`), the system distinguishes between:
- **Observed Source Place:** `site_id`, `location_id`, `location_name`, GPS coordinates (where the risk, noise, or organism was observed).
- **Harmed / Protected Land Anchor:** `protected_land_site_id` / `protected_land_address` for biosecurity; `complainant_site_id` / `complainant_address` for noise/smoke.
- The two anchors may be identical, different, or the protected land anchor may be `NULL` (unknown-yet). `NULL` is a legitimate state, not a defect.

### 4. Scanner & ALPR Hierarchy (Freedom Camping & Parking)
- ALPR-first camera capture via `process-officer-scan` and `fcm-inference` / Plate Recognizer fallback.
- Manual plate entry is strictly a fallback after ALPR failure.
- Every valid scan requires an immutable, watermarked photo with EXIF timestamp, GPS coordinates, officer ID, and site/zone context.
- Scanner supports 4 modes: **Standard Scan**, **Zoom Scan**, **Detail Scan**, and **Bulk Scan**.

### 5. Required Platform Systems
- **Atlas:** Capability map (`bob_capability_map`), graph edges (`bob_app_map_edges`), and blast-radius evaluation (`flow_reach` vs `fk_reach`).
- **Caddie:** Tool catalogue generator mapping Atlas-wired capabilities into available AI tools.
- **Conductor:** Turn dispatcher, routing engine, and governance boundary for AI actions and chat turns.
- **Oracle:** Truth-state describer for turn, caller, candidate effect, proof grade, and domain safety/welfare state.

---

## 3. Detailed Module Specifications Summary

### A. Freedom Camping (`freedom_camping`)
- **Modes:** Standalone Mode (minimal `/scan` interface for scan operators) vs. Integrated Mode (full shifts, credentials, welfare, dispatch).
- **Overnight Verification:** Requires evening scan (pre-midnight) + morning scan (post-midnight) at same site/zone $\rightarrow$ `vehicle_overnight_sessions`.
- **SCV Registry:** Primary lookup via `canonical_scv` CSV import; fallback to NZSCV API proxy. Expired certificates reject compliance.

### B. Noise Control (`noise_control`)
- **6-Step Assessment Workflow:** Attend $\rightarrow$ Identify $\rightarrow$ Measure/Assess Matrix $\rightarrow$ History/Config Check $\rightarrow$ Action Taken $\rightarrow$ Follow-Up & Audit.
- **Matrix Calculation:** Volume (0–4) + Time (1–4) + Tone (0–2) = Total (Excessive threshold $\ge 5$ default).
- **Enforcement Ladder:** Verbal Warning $\rightarrow$ Excessive Noise Direction (END, 72h validity) $\rightarrow$ Abatement Notice (RMA s.326) $\rightarrow$ Equipment Seizure (RMA s.327, itemized in `noise_seizures`, requires police presence).

### C. Biosecurity (`biosecurity`)
- **Target Pests:** Chilean Needlegrass (*Nassella neesiana*), pest plants, and vector risk.
- **Inspections:** Earth-moving machinery washdown and transport checks across Regional Inspection Zones (e.g., Zone 1 Blenheim, Zone 2 Seddon, Zone 3 Ward).
- **Governed Command:** `submit-biosecurity-assessment` Edge Function handling watermarking, storage, AI species classification enrichment, dual-place anchors, notice/referral references, and single-receipt idempotency.

### D. Parking Enforcement (`parking_enforcement`)
- **Zones:** Blenheim kerbside & carpark zones (ALPHA & BRAVO) + Picton ferry arrival/departure 30-minute enforcement windows.
- **Warrants:** Wardens operate under s.128E Land Transport Act 1998 warrants recorded in `staff_credentials`.

---

## 4. Maintenance & Verification Policy

- Before modifying shared tables, RPCs, or components, execute Atlas capability and blast-radius checks.
- Cross-check against `supabase/schema.sql` for ground truth.
- Run complete mobile TypeScript (`npx tsc --noEmit`) and Expo configuration validation (`npx expo config --type public`) after any mobile update.
- Ensure all backend changes maintain full backwards compatibility or include explicit migration paths.
