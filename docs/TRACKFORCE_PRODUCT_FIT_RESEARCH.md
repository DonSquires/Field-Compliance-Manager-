# Trackforce Product Fit Research

> **Retrieved:** 2026-10-08  
> **Scope:** Trackforce / TrackTik / GuardTek public product material compared with Field Compliance Manager (FCM) source, live Atlas and the authenticated Reports UI.  
> **Overall confidence:** Medium. This is a public-source product benchmark, not a vendor evaluation or authenticated product teardown.

## Executive Summary

TrackTik is a strong benchmark for contract-security operations, but Trackforce is not one identical application: its current site presents TrackTik, GuardTek and Silvertrac as separate products under one brand. FCM already has substantial equivalents for dispatch, workforce, patrol/checkpoints, incident evidence, reporting, client access and finance, plus a broader New Zealand compliance and accountability model. The most important gap is the visible, trustworthy connection from field work through service proof into commercial outcomes; several screens exist, but Atlas and prior schema investigation do not support claiming every field-to-finance path is live. **Match Trackforce’s clear command-center hierarchy, guided field work, exception management and client proof, while preserving FCM’s harmed-party anchoring, tenant boundaries and client-owned operational truth rather than copying its product architecture.**

## How to Read This Document

| Reader | Start here | Decision supported |
|---|---|---|
| Product owner | Executive Summary, Tactical Layer, Recommendations | Which workflow gaps are worth closing first |
| UX / engineering | UI Observations, Capability Matrix | What to inspect or improve without inventing data paths |
| Commercial / finance | Where to Play, Recommendations 2 and 4 | Where FCM complements or differs from a guard-workforce suite |

This document uses three evidence tiers:

- **T1:** FCM live UI, generated live schema and named Atlas `reads`/`writes`/`calls`/`invokes` edges. “Wired” does not mean exercised; Atlas `exercised` is currently unpopulated.
- **T5:** Trackforce-controlled product pages, product screenshots, webinars and case studies. These establish what the vendor advertises, not independent proof of performance.
- **T6:** Analyst inference or a roadmap hypothesis that needs validation with customers, product telemetry or a Trackforce demonstration.

No independent market-share or comparative performance study was used. Confidence in conclusions about competitive strength is therefore capped at **M**.

## 0. Context Fitness and Framework Selection

This is an external product-fit question for a New Zealand field-compliance platform serving security providers, councils/agencies and their clients. The immediate comparator is Trackforce’s security operations portfolio, especially TrackTik for global guard-workforce operations and GuardTek for EMEA field operations. FCM’s internal behavior and Atlas provide architecture evidence, but not customer acquisition, retention, revenue or workload-volume data.

| Lens | Use | Why |
|---|---|---|
| 7 Powers | Apply, cautiously | Separates durable advantage from a visible feature list |
| Switching-cost decomposition | Apply as hypotheses | Tests whether an integrated field-to-invoice workflow creates customer lock-in |
| Aggregation / value-chain position | Apply | Tests who owns operational data and the client relationship |
| Where to Play / How to Win | Apply | Keeps FCM from copying a broader vendor suite without a distinct wedge |
| Wardley evolution | Scan only | Helps separate commodity guard operations from differentiated NZ compliance workflows |
| Market sizing / win-loss | Skip | No independent market or FCM sales evidence was available |

## 1. Competitive Set

| Tier | Product / alternative | Treatment |
|---|---|---|
| Primary benchmark | TrackTik | Direct reference for multi-site security-provider operations, scheduling, tours, incidents, billing and client reporting. |
| Adjacent benchmark | GuardTek | Trackforce’s EMEA-focused field-operations product. Strong reference for mobile patrol, lone-worker protection, client e-reporting and visible field proof. |
| Portfolio context | Silvertrac | Named in Trackforce’s rebrand announcement, but not evaluated feature-by-feature here. Trackforce says existing products remain in place. |
| Substitute | Spreadsheets plus point systems | A credible operational alternative for smaller providers; Trackforce’s case study describes replacing four systems, but this is one vendor-published customer story. |
| Target product | FCM | Broader NZ field-compliance and accountability platform. The comparison is selective product fit, not a claim that FCM should become a global payroll package. |

Trackforce’s rebrand page says the three products are “the same products” under a shared brand and that existing customers do not need to migrate. Its product catalogue describes TrackTik and GuardTek as separate platforms, sharing an intelligence layer. Do not model them as one proven common UI or as three independent competitors. [T5]

## 2. 7 Powers Heat Map

Ratings below are directional. Trackforce figures and capabilities are vendor-reported; FCM ratings use source/schema/Atlas evidence. A rating is not a measured market advantage.

| Power | TrackTik / Trackforce | FCM |
|---|---|---|
| Scale economies | 🟡 Moderate: vendor reports 4,600+ organizations and 50+ countries; independently unverified. (T5) | 🔴 Not established: no comparable deployment or unit-cost evidence reviewed. (T1) |
| Network effects | 🔴 No direct cross-customer network effect demonstrated on the reviewed pages. (T5) | 🔴 No network effect established; shared canonical entities are architecture, not proof of network value. (T1) |
| Counter-positioning | 🔴 No evidence that incumbents cannot copy its integrated model. (T6) | 🟡 Potential: harmed-party anchoring, tenant-scoped custody and NZ compliance profiles differ from a guard-workforce suite, but no customer win data proves this advantage. (T1/T6) |
| Switching costs | 🟡 Moderate: integrated staffing, tours, client reporting, payroll and invoicing can create workflow and migration costs; the vendor case study describes consolidation. (T5) | 🟡 Moderate by design: shared org/place/agreement/evidence records create continuity; the canon explicitly rejects holding client operational truth hostage to a provider. (T1) |
| Branding | 🟡 Moderate: established named products and vendor-reported scale, without independent preference or price-premium data. (T5) | 🔴 Unknown: no independent brand-awareness or pricing-premium evidence. (T6) |
| Cornered resource | 🔴 None demonstrated in public evidence reviewed. (T5) | 🟡 Possible NZ rule, jurisdiction and field-compliance knowledge; not exclusive and not yet evidenced as a moat. (T6) |
| Process power | 🟡 Moderate: product is organized around linked scheduling, activity, reports and back-office workflow; duration-to-replicate is unknown. (T5/T6) | 🟡 Emerging: FCM has shared operational spines and governed module submissions, but some cross-domain flows remain incomplete. (T1) |

## 3. Switching-Cost Decomposition

The scores are analyst estimates, not measured churn or migration data. Progress bars are comparative hypotheses only. [T6]

| Dimension | TrackTik | FCM | Evidence / implication |
|---|---:|---:|---|
| Financial / contractual | ██████░░░░ 6/10 | ████░░░░░░ 4/10 | TrackTik advertises site-based/module packaging; FCM models service agreements, rate rules and invoices. Neither score is based on churn data. (T5/T1/T6) |
| Data / migration | ███████░░░ 7/10 | ██████░░░░ 6/10 | Multi-year tours, timesheets, reports and billing can be costly to move. FCM’s canonical spine and contract-outlives-custody doctrine should make legitimate portability easier. (T5/T1/T6) |
| Workflow / integrations | ████████░░ 8/10 | █████░░░░░ 5/10 | Trackforce advertises payroll/ERP partners and APIs. FCM has dispatch, roster, reporting and finance surfaces, but end-to-end data paths must be proven per workflow. (T5/T1) |
| Identity / customer relationship | ██████░░░░ 6/10 | ███████░░░ 7/10 | TrackTik claims a portal and client reporting; FCM’s operating model makes the client/place a durable anchor, independent of provider custody. (T5/T1) |
| Learning / procedure | ██████░░░░ 6/10 | █████░░░░░ 5/10 | Site-specific orders, tour rules and report templates encode procedures. FCM’s jurisdiction/module configuration can encode local rules, but there is no measured training curve. (T5/T1/T6) |
| Trust / continuity | ███████░░░ 7/10 | ████████░░ 8/10 | Trackforce advertises audit controls and customer portals. FCM’s canon sets stronger continuity expectations for client-owned operational truth; runtime conformance varies by flow. (T5/T1) |

**Key insight:** FCM should compete on trustworthy continuity and regulated field accountability, not manufacture lock-in by making client history difficult to export. The provider’s commercial configuration may be private; the place’s operational record follows the harmed party and place under FCM’s canon. [T1]

## 4. Aggregation and Disruption

| Question | Finding | Evidence |
|---|---|---|
| Who owns the user relationship? | TrackTik sells to security firms and enterprise security teams, with client portal access advertised. FCM serves providers, clients and agencies through service agreements and role-scoped surfaces. | Product positioning and portal claims (T5); FCM service model and live Reports UI (T1). |
| Are marginal software costs near zero? | SaaS delivery implies software scaling, but support, integrations, compliance and implementation costs remain. No unit economics are public. | No public cost data; do not treat “scale” marketing as zero-cost economics. (T5/T6) |
| What layer is being integrated? | TrackTik’s central thesis is that staffing, attendance, patrol, reports and billing should share one operational record. | Vendor product/workflow pages and case study (T5). |
| Where does FCM differ? | FCM’s shared model includes organization, agreement, place, staff, dispatch, evidence, finance and compliance profiles; harmed-party access and NZ statutory context are first-class. | FCM architecture brief/canon (T1). |
| Is a disruptive trajectory proven? | No. Public marketing and one vendor-published story are insufficient to establish market-wide displacement or margin transfer. | Evidence gap. (T5/T6) |

The vendor’s public case study says one customer replaced four applications and reduced payroll processing from about a day and a half to minutes. Treat this as a customer story selected and published by Trackforce, not an independent benchmark. [T5]

## 5. Strategy: Where to Play / How to Win

| Product | Publicly stated where-to-play | Evidence-supported how-to-win | Limits of evidence |
|---|---|---|---|
| TrackTik | Global security firms and enterprise security operations | Join guard attendance, patrol, dispatch, reports, payroll preparation, billing and BI; connect customer reporting to verified service delivery. | Public pages and vendor case study only; resource allocation, retention and actual integration performance are unknown. (T5) |
| GuardTek | Field operations, explicitly marked EMEA-focused | Mobile proof of presence, client e-reporting, real-time command-center visibility, lone-worker safety and PTT. | Product claims, no authenticated environment. (T5) |
| FCM | NZ providers, councils/agencies and commercial clients across field compliance modules | Share the organization/place/agreement/evidence spine while preserving lawful disclosure depth, client continuity and human-governed statutory outcomes. | Product architecture is clear; commercial win rate and end-to-end completion metrics are not available. (T1/T6) |

TrackTik’s “revealed strategy” is consistent with its stated one-platform thesis: public pages foreground linked schedules, field activity, billing and reporting, and the Colonial story describes replacing separate admin systems. There is not enough public evidence to infer investment allocation or internal strategy beyond that. [T5]

### Wardley scan

Basic clock-in, report storage, schedules and invoice export are increasingly commodity capabilities; they should be dependable and integrated rather than bespoke differentiators. [T6] Site-specific field procedures, evidentiary quality, jurisdictional rules and privacy-safe client transparency are more differentiating for FCM. [T1/T6] The shared activity/event spine is a product foundation still being completed: FCM’s architecture brief says `location_events` is present but not yet the universal writer. Do not claim a complete unified event stream until writers and readers are verified. [T1]

## 6. Blue Ocean Check

| Eliminate | Reduce | Raise | Create |
|---|---|---|---|
| Duplicate entry and parallel “source of truth” records. (T1) | One-size-fits-all guard-workforce features that do not serve FCM’s NZ customer jobs. (T6) | Proven service delivery, scope clarity, accessibility of the next action, record provenance and service-agreement context. (T1/T5) | A NZ field-compliance operating layer where a client’s place and accountability persist across providers, with specialist modules sharing the same field/evidence spine. (T1/T6) |

This is a positioning hypothesis, not a validated “blue ocean.” Confirm it with provider, council and client interviews before sales or roadmap commitments. [T6]

## 7. Adoption Stage Assessment

| Question | Finding |
|---|---|
| TAL position | Trackforce presents as an established vendor; FCM’s customer adoption stage is unknown without sales/usage evidence. (T5/T1) |
| Chasm status | Cannot be rated for FCM from repository data. No cohort, reference-customer or sales-conversion evidence was reviewed. |
| Whole-product gap | The highest-priority gap to validate is a consistently exercised path from scheduled/assigned work through evidence, client report and finance. (T1/T6) |
| Bowling-alley head pin | Hypothesis: NZ security providers serving councils and commercial sites that need auditable field compliance and client reporting. Validate with customer interviews and procurement evidence before acting. (T6) |

## 8. Tactical Layer

### UI Observations

The public TrackTik overview embeds a sample command-center dashboard with top product navigation, global search/scope controls, four headline measures, a live operations map, activity feed, site coverage, incident categories and weekly hours/overtime. It connects workforce, site coverage, response and performance in one scan. This is vendor-published sample content, not an authenticated production session. [T5]

The child product pages show a repeatable pattern:

- **Configure:** build sites, checkpoints, tour tasks, report templates and dispatch workflows.
- **Operate:** show current guard status, location, route/checkpoint progress and open response work.
- **Handle exceptions:** surface missed checkpoints, SLA thresholds, lone-worker alarms and incomplete reports.
- **Prove:** retain timestamped photo/video/audio/GPS evidence and turn operational records into client reports.
- **Improve:** roll up activity into trends, labor costs and shareable dashboards.

The public UI examples use map-and-queue composition for command work, guided forms on mobile, and report/dashboard previews for managers and clients. Trackforce’s public pages route to a sales demo rather than an unauthenticated sandbox. I could inspect the public sample dashboard and screenshots, but not verify its logged-in product, keyboard behavior, mobile layouts or real workflow states. [T5]

The authenticated FCM Reports surface shows an explicit operating spine—organisation, agreement, place, staff, roster, dispatch, evidence, finance and reports—plus agreement/date filters, report-draft generation, custom reports, daily rollups and review/delivery actions. The Admin Hub source has “Today at a glance,” a priority queue, quick actions, five operational measures, a seven-day dispatch trend, periodic refresh and realtime subscriptions. Field Operations has role/module-gated “Respond now” and “Review and investigate” workspaces. [T1]

This is a sound foundation and already follows the task/exception shape. The visual gap is narrower: TrackTik’s advertised overview joins map, coverage, activity feed, incident state and labor trend in one place; FCM distributes those views across Admin Hub, Field Operations, Dispatch, Roster, Reports and Live Map. A unified view is a candidate improvement, not permission to duplicate those surfaces or create an unbacked aggregate.

### Feature / Capability Matrix

| Capability | Strategic weight | TrackTik / GuardTek | FCM present state |
|---|:---:|---|---|
| Unified operations overview | H | TrackTik publishes a sample command dashboard joining metrics, map, activity, site coverage and incidents. (T5) | **Present, split:** Admin Hub has metrics, a prioritized exception queue, quick links, trend and realtime subscriptions; Field Operations and Live Map are separate. (T1) |
| Dispatch and response | H | Nearest-guard matching, SLA timers, guided status and multi-guard response advertised. (T5) | **Present and wired:** Dispatch Console reads jobs/resources/SLA/GPS and invokes intake/context/arrival RPCs; Atlas shows `calls`/`invokes`. `exercised` remains unknown. (T1) |
| Guard tours / checkpoint proof | H | NFC, barcode, QR, GPS and manual check-ins; action can be attached to a checkpoint. (T5) | **Present and wired:** Patrol, checkpoints, `process-officer-scan`, visits, stops and reports exist. (T1) |
| Incident reports and media | H | Guided, configurable reports with timestamped photo/video/audio/GPS; scheduled reports and AI assistance advertised. (T5) | **Present:** field-report and evidence flows exist; report packs and review workflows exist. Exact ReportPro-style AI edit history is not established. (T1) |
| Workforce / certifications | H | Employee records, certs, matching, scheduling, attendance, leave and overtime tools advertised. (T5) | **Present, broad:** roster operations, staff credentials, availability, readiness and labour-cost RPCs are in the app. Confirm lifecycle parity and usability with human tests. (T1) |
| Client transparency | H | View-only portal, real-time e-reports and customer-specific reports advertised. (T5) | **Present:** Client Portal reads report packs, observations and invoices; provider review/publication flow is in Reports. (T1) |
| Contract to invoice / payroll | H | Contract rules, actual hours, invoicing and payroll integrations are TrackTik’s central differentiator. (T5) | **Partial:** agreements, rates, finance and invoices exist, but Atlas/memory evidence says some historic patrol kilometres/costs do not feed finance; do not claim end-to-end field-to-payroll parity. (T1) |
| Analytics and data export | M | Custom dashboards, role permissions, scheduled data replication and BI connections are advertised. (T5) | **Partial:** consolidated and custom report surfaces exist. A general vendor API/warehouse-replication parity path was not verified in this review. (T1) |
| Safety / lone worker | H | Panic, fall/no-motion detection, check-in/watch features, PTT and emergency routing advertised across product lines. (T5) | **Present, separate workflows:** welfare alerts, mobile safety, check-in and PTT are in FCM architecture; verify parity per client/region. (T1) |
| Regulated compliance modules | H for FCM | Public pages focus on guard operations, guarding workflows and US/EU compliance examples. NZ statutory coverage not established. (T5) | **FCM differentiation:** parking, noise, smoke, biosecurity, CCTV and freedom-camping/compliance surfaces share the field platform. (T1) |
| Data ownership across providers | H | Trackforce enterprise pages claim vendor-independent ownership and continuity; rebrand page says existing TrackTik/GuardTek/Silvertrac customers keep their products. (T5) | **Canon is explicit:** client operational truth remains anchored to the harmed party/place when the provider changes; implementation remains a per-flow conformance question. (T1) |

### GTM and Distribution Comparison

| Dimension | Trackforce / TrackTik | FCM evidence |
|---|---|---|
| Pricing model | Trackforce says pricing is based on protected site count and selected modules, with a custom quote; not seat-priced, according to its pricing page. (T5) | No public FCM pricing schedule was reviewed. Do not infer parity. |
| Free tier | No public free tier was identified on the reviewed pricing pages. (T5) | Unknown from available evidence. |
| Enterprise motion | Demo/quote-led; public enterprise page emphasizes multi-site, multi-vendor operations, integrations and board reporting. (T5) | FCM has CRM, client onboarding, agreements and a client portal, but its sales funnel and buyer conversion were not reviewed. (T1) |
| Distribution | Direct sales demos, webinars, customer stories, support/implementation services and partner integrations. (T5) | Direct product access is visible in the app; distribution and channel economics are unknown. |
| Bundle leverage | Modules across frontline, workforce and financial back office are positioned as one suite; TrackTik, GuardTek and Silvertrac remain named product families. (T5) | Shared FCM schemas and modules exist, but bundle performance is not measured. (T1) |

### Customer and User Signals

- Trackforce’s Colonial Security story reports replacing four systems and reducing payroll processing from roughly a day and a half to minutes. Vendor-selected case study; not an independent or representative outcome. [T5]
- Trackforce’s public webinars advertise live walkthroughs of scheduling and invoicing, but the public material does not expose the actual authenticated flows. [T5]
- FCM’s live Reports screen exposes agreement scoping and report review/delivery; Atlas has wired reads/calls across reports, dispatch, roster and patrol. Atlas `exercised` is null, so this is not proof of end-to-end completion. [T1]

## 9. Win/Loss Pattern Mapping

| Pattern | Structural cause | Framework attribution |
|---|---|---|
| No observed FCM win/loss pattern can be stated | No FCM win/loss interviews, CRM outcome analysis or buyer-switching evidence were reviewed. | Not scored; collecting evidence is the next step. |
| Hypothesized competitive objection: “one integrated workforce-to-invoice system” | TrackTik publicly connects attendance, scheduling, billing, payroll preparation and BI; FCM’s historic patrol cost path is not fully connected. | Switching cost / process power; hypothesis only (T5/T1/T6). |
| Hypothesized FCM differentiation: NZ accountability, place and compliance depth | FCM’s canon and modules include harmed-party anchors, provider-independent continuity and NZ-specific compliance workflows. | Counter-positioning / cornered knowledge; no deal-level evidence yet (T1/T6). |

## 10. Strategic Recommendations (O→I→R→C→W)

### Recommendation 1: Make the existing operations cockpit more composable

- **Observation (T1):** FCM already has a priority queue, duty/dispatch/welfare/breach/observation metrics and quick links; TrackTik’s public dashboard combines map, site coverage, activity and incidents.
- **Implication:** The differentiating work is a common, scoped scan—not a new duplicate command system.
- **Response:** In the next UX slice, prototype a role-aware overview that reuses current widgets and links, adds site-coverage/map context only from verified live sources, and keeps agreement/place scope visible. Keep the existing Admin Hub and Field Operations ownership boundaries.
- **Confidence:** M; assumes users need fewer context switches, which should be validated with operations staff.
- **Watch:** time to find the highest-priority open item, stale-data warnings, wrong-scope navigation, and task completion in a human test.

### Recommendation 2: Close the field-to-finance evidence chain deliberately

- **Observation (T1):** FCM has roster, dispatch, patrol and finance surfaces, but known historic patrol-log kilometres/costs are inert in payloads and do not feed the finance pipeline.
- **Implication:** TrackTik’s most meaningful product advantage is the verified-hours-to-invoice chain, not its colors or card shapes.
- **Response:** Inventory the current governed writers from roster/dispatch/stop to approved work units, pay lines, rates and invoices; distinguish future operational truth from historical import data. Get an explicit owner decision before retroactively changing P&L or billing.
- **Confidence:** M; the historic gap is documented, but scope and commercial policy must be decided by the owner.
- **Watch:** Atlas `writes`/`calls` edges, an invoice trace with source shift/dispatch IDs, reconciled quantities, and negative tests for changed/cancelled work.

### Recommendation 3: Add reviewable AI reporting only inside FCM’s evidence doctrine

- **Observation (T5):** Trackforce advertises AI rewriting, summaries and a side-by-side audit trail; these are vendor claims. FCM’s Bob doctrine requires human-governed identity, legal and enforcement decisions.
- **Implication:** An AI summary can reduce review time, but replacing original field notes or blurring inference with fact damages evidentiary trust.
- **Response:** If prioritized, implement an opt-in report draft/summary that retains the original, labels AI text, stores source references and audit metadata, and requires a human to accept it. Never update the canonical observation or enforcement result automatically.
- **Confidence:** M; workflow value is plausible but requires guard/supervisor research and a privacy/security review.
- **Watch:** correction rate, review time, unsupported-claim rate, source-link completeness, and successful export of both original and accepted revision.

### Recommendation 4: Lead with FCM’s accountability wedge; integrate commoditized back office

- **Observation (T1/T5):** TrackTik focuses on contract guarding and labor-to-invoice automation; FCM’s canon covers client/place continuity, NZ statutory modules and role/purpose-bound disclosure.
- **Implication:** Rebuilding all global payroll/benefit/ERP functionality would dilute FCM’s differentiated compliance spine.
- **Response:** Match the provider workflow ergonomics, but use governed integrations for payroll/accounting where feasible; invest FCM-owned roadmap in NZ compliance, defensible evidence, client continuity and cross-module reporting.
- **Confidence:** M; assumes FCM’s primary target remains NZ providers, councils/agencies and clients as defined in its product architecture.
- **Watch:** buyer interviews, procurement/RFP requirements, integration demand, and which feature gaps actually block adoption.

## Workforce profile evidence update (2026-10-19)

This update governs the staff-directory and profile interaction added in the
People, Pay & HR workspace. It is product evidence, not a legal-compliance
determination.

| Source | Verified fact | FCM design implication |
|---|---|---|
| Health NZ / Te Whatu Ora GETS FPO 31955373 | The public notice describes rostered and ad hoc security officers, patrols, incident response and de-escalation, alarm/CCTV response, patient watches and emergency support. It is a future procurement opportunity, not the released RFP; the detailed vetting, training, competency and record clauses are not public yet. | Keep credentials, skills, training, inductions and evidence generic and versionable. Do not label a field or workflow as “Health NZ compliant” until the released RFP is reviewed. |
| Ministry of Justice / PSPLA training and skills guidance | Property guards, crowd controllers and personal guards must satisfy the stated NZQA unit or skills standards unless covered by the listed NZ Certificate pathways; the Record of Achievement supports the permanent badge pathway. | Keep credential type, issuer, number, issue/expiry, verification and evidence separate from training records, and show both within one staff profile. |
| NZSA Security Services Good Practice Guidelines (April 2023) | The Ministry of Justice links the industry guideline developed with NZSA, E Tū, WorkSafe and others as guarding-risk guidance. | Surface H&S readiness and site induction evidence with the person, while keeping operational hazards/incidents on their owning place/work records. |
| Deputy training-requirements help | Deputy supports staff training records and schedule filtering by valid, non-expired training modules. | Use searchable one-row staff lists and preserve skill/training expiry as roster-eligibility inputs rather than decorative profile data. |
| Trackforce/GuardTek employee HR profile help | The employee record separates core HR, additional/system attributes and linked time/labour and payroll profile views. | Use one stable staff identity with role-specific profile tabs; do not create parallel staff entities for payroll, rostering or credentials. |
| InTime security scheduling page | InTime advertises filtering staff by training credentials and pay rates for assignment. This is vendor marketing, not verified technical documentation. | Treat credential/pay filters as a workflow benchmark only; FCM assignment must continue through its governed readiness, availability and pay-rule paths. |

**Interaction ruling:** the organization-wide staff directory uses a dense,
searchable, one-row-per-person table. Selecting a person opens a stable
independent browser window so the directory and profile can remain active on
separate screens. Credential, skill, training, document, induction, asset,
timesheet, leave and HR-case summaries remain single-line records and open a
separate stable detail URL. Payroll role and work-readiness changes continue
through `set_staff_pay_role_code` and `set_staff_work_readiness`; the browser
does not update `staff_profiles` directly.

**Known gap:** there is no dedicated staff injury, exposure or wellbeing record
path in the current workforce schema. The profile says so explicitly and does
not repurpose general HR notes for clinical information. Site induction is
shown as staff-specific H&S readiness evidence; operational incidents and place
hazards remain on their canonical work/place spines.

## Three Horizons

| Horizon | Build direction | Guardrail |
|---|---|---|
| H1: 0–12 months | Queue-first command overview, report/evidence provenance, human-verified flows and workflow completion measures. | Reuse existing spines; no dashboard metric without a live source and freshness label. |
| H2: 12–36 months | Governed roster/dispatch/finance trace, client self-service and approved payroll/accounting integrations. | Historical data does not silently alter invoices or profitability. |
| H3: 36+ months | Provider-independent physical-compliance record across sites, agencies, operators and modules; interoperable with client GRC/BI. | Preserve data ownership, NZ privacy and the separate legal anchor of harmed party and subject. |

## Cross-Framework Contradictions

| Contradiction | Evidence A | Evidence B | Resolution |
|---|---|---|---|
| Trackforce advertises end-to-end automation; FCM canon emphasizes human custody and governed writes. | TrackTik says field activity can flow to invoice/payroll automatically. (T5) | FCM requires approval and provenance for money-, identity- and enforcement-critical changes. (T1) | Automate reconciliation and drafts; keep accountable approval where a change alters a legal or financial record. |
| TrackTik’s integrated suite may create switching costs; FCM intentionally values continuity across provider changes. | Vendor customer story describes consolidating four systems. (T5) | FCM says client operational truth stays with the place when the custodian/provider changes. (T1) | Compete on integration and trust, not data captivity. |
| The public product appears exact-fit; the product boundary is narrower. | TrackTik/GuardTek overlap strongly with security operations and patrol. (T5) | FCM includes additional NZ regulatory and harmed-party workflows. (T1) | Use Trackforce as a workflow/UI benchmark, not as the architecture or full product specification. |

## Assumption Registry

| # | Assumption | Confidence | Evidence | What would invalidate it |
|---|---|---|---|---|
| 1 | FCM’s target remains NZ security providers, councils/agencies and client organizations. | H | FCM platform architecture brief (T1) | Owner changes product segment or geographic focus. |
| 2 | Cross-surface operational visibility is more valuable than another standalone module. | M | TrackTik sample dashboard and FCM existing operating surfaces (T5/T1) | Operator interviews show the primary bottleneck is missing domain capability, not navigation/context switching. |
| 3 | A proved, audited finance chain is a strategic gap. | M | FCM architecture/memory investigation and TrackTik vendor positioning (T1/T5) | Live tracing proves every relevant work item already reaches approved financial records. |
| 4 | Trackforce is an “industry standard.” | L | Vendor-reported customer and country counts only (T5) | Independent market-share, adoption and procurement research. |

## Adversarial Self-Critique

**1. Marketing is not the product.** Public pages show curated examples and promises, not error states, permission behavior, offline sync, setup friction, latency, actual module dependencies or full customer UI. An authenticated demo and practitioner interviews are needed before treating any claim as implemented.

**2. FCM’s internal sources can overstate completeness.** A page and an Atlas `wired` edge do not prove the action was exercised, that its data is correct, or that a client can use it. Atlas `exercised` is null; each priority workflow still needs a role-specific human test and persisted-state check.

**3. A broad parity roadmap could be strategically wrong.** TrackTik sells a global workforce/back-office suite. FCM’s strongest value may be regulated accountability and continuity. Copying payroll, benefits and every visitor/asset module could consume capacity without helping FCM’s NZ buyers.

## Revision Triggers

| Trigger | Reassess | When |
|---|---|---|
| Authenticated TrackTik/GuardTek demo becomes available | UI states, permissions, exceptions, mobile/offline and integration behavior | Before detailed UI parity specification |
| FCM provider/client interviews or win/loss notes are available | Target segment, switching costs, command-center priorities and product positioning | Before committing the next large roadmap tranche |
| Field-to-invoice source trace is proven live | Recommendation 2 and the finance gap rating | Before any historical billing/cost backfill |
| Independent market-share/procurement evidence is found | “Industry standard” assumption and competitive set | Before market-positioning claims |

## Sources

**Trackforce first-party product material, retrieved 2026-10-08. All capability descriptions below are vendor claims unless the page is explicitly identified as a case study or demo.**

- [Trackforce products catalog](https://www.trackforce.com/products/)
- [Health NZ security services future procurement opportunity, GETS RFx 31955373](https://www.gets.govt.nz/HEALTHNZ/ExternalTenderDetails.htm?id=31955373)
- [Ministry of Justice — training and skills for private security licences](https://www.justice.govt.nz/tribunals/licences-certificates/pspla/training-and-skills/)
- [NZSA Security Services Good Practice Guidelines, April 2023](https://security.org.nz/wp-content/uploads/2023/04/NZSA-NZ-Security-Services-Good-Practice-Guidelines_April-2023.pdf)
- [Deputy — managing training requirements](https://help.deputy.com/hc/en-au/articles/4657753960463-Managing-training-requirements)
- [Trackforce/GuardTek — managing the Employee HR Profile](https://rtmsoft.zendesk.com/hc/en-us/articles/360057609331-Managing-the-Employee-HR-Profile)
- [InTime — scheduling software for security](https://intime.com/scheduling-software-security/)
- [TrackTik platform](https://www.trackforce.com/products/tracktik/)
- [GuardTek platform](https://www.trackforce.com/products/guardtek/)
- [Security operations](https://www.trackforce.com/products/tracktik/security-operations/)
- [Command Center](https://www.trackforce.com/products/tracktik/command-center/)
- [Guard management](https://www.trackforce.com/products/tracktik/guard-management/)
- [Guard Tour System](https://www.trackforce.com/products/tracktik/security-guard-tour-system/)
- [Guard Tour App](https://www.trackforce.com/products/tracktik/security-guard-tour-app/)
- [Mobile patrol](https://www.trackforce.com/products/tracktik/mobile-patrol/)
- [Security Guard Dispatch](https://www.trackforce.com/products/tracktik/security-guard-dispatch/)
- [Security Incident Reporting](https://www.trackforce.com/products/tracktik/security-incident-reporting/)
- [People Management](https://www.trackforce.com/products/tracktik/people-management/)
- [Contracts & Invoicing](https://www.trackforce.com/products/tracktik/contracts-invoicing/)
- [Business Intelligence](https://www.trackforce.com/products/tracktik/business-intelligence/)
- [ReportPro AI](https://www.trackforce.com/products/tracktik/reportpro-ai/)
- [Integrations](https://www.trackforce.com/products/integrations/)
- [Enterprise security](https://www.trackforce.com/who-we-serve/organization-types/enterprise-security/)
- [Pricing approach](https://www.trackforce.com/products/tracktik/pricing/)
- [Security and trust](https://www.trackforce.com/company/trust/)
- [TrackTik/GuardTek/Silvertrac brand change](https://www.trackforce.com/lp/see-whats-changed/)
- [Colonial Security customer case study](https://www.trackforce.com/resources/case-studies/colonial-security-services-data-driven-transformation/)
- [From Shift to Invoice webinar series](https://www.trackforce.com/resources/webinars/from-shift-to-invoice-a-tracktik-product-series-part-1/)

**FCM evidence, inspected 2026-10-08.** `FOUNDATION.md`; `docs/FCM_PLATFORM_ARCHITECTURE_BRIEF.md`; `docs/canon/PRODUCT_DESIGN.md`; `docs/canon/ORG_SERVICE_MODEL.md`; `docs/canon/LOCATION_HOUSE_MODEL.md`; `docs/canon/UNIFIED_FIELD_OPERATIONS_MODEL.md`; `docs/canon/ACCESS_MODEL.md`; `docs/REBUILD_PLAN.md`; current authenticated Reports page; `apps/web/src/pages/AdminHubPage.tsx`, `FieldOperationsPage.tsx`, `DispatchConsolePage.tsx`, `RosterOperationsPage.tsx`, `PatrolPage.tsx`, `ReportsHubPage.tsx`, `ClientPortalPage.tsx` and finance pages; live `supabase/schema.sql`; and filtered `bob_capability_map` / `bob_app_map_edges` results. Atlas state is evidence of wiring, not exercise.