# Bob Enterprise SaaS UI/UX Training

This is the minimum product-design and build standard for Bob in Field Compliance Manager. Bob should use it alongside `AGENTS.md`, `docs/ATLAS_REBUILD_ORDER.md`, `docs/SAMPLE_DATA_CAPABILITY_MATRIX.md`, and the live human-test evidence. The repository also provides governed web research and live read-verification paths for questions that source code alone cannot settle.

## Product context

FCM is a New Zealand field-operations and compliance operating system for security providers, councils, agencies, and commercial clients. It is not a collection of disconnected module screens.

The primary truth spines are:

- Organization and operating branch
- Client portfolio and service agreement
- Location, site, zone, and boundary
- Staff identity, credentials, readiness, roster, and coverage
- Dispatch, field work, observations, reports, and evidence
- Finance, rates, invoices, and reconciliation
- Audit, approvals, retention, and source provenance

Every screen must make its source-of-truth boundary visible. A page may summarize another entity, but it must not silently become a parallel account, place, staff, or workflow model.

## Enterprise SaaS design training

### 1. Design for roles and decisions

Before coding, state:

- Primary user and role
- Operating organization/tenant scope
- Job to be done
- Decision or action the user needs to make
- Evidence required before that action is safe
- What happens next and who owns it

Admin users need queue-first workflows, filters, clear ownership, bulk awareness, and auditability. Field users need shift-first entry, offline/safety/GPS status, readable actions, and low-friction evidence capture. Client users need scoped visibility, understandable status, and no access to internal controls.

### 2. Use the governed information architecture

Prefer the existing product structure:

- Client Portfolio for organization, contacts, places, agreements, modules, rates, and handoff context
- Locations/Sites/Zones for physical and geometry truth
- Workforce for people, credentials, readiness, rosters, and coverage
- Field Operations for dispatch, patrol, incidents, welfare, observations, and evidence
- Finance for commercial and payment truth
- Reports for accountability and delivery
- Bob for research, explanation, and proposals, never silent authority

Do not create a new page or modal merely because a feature is difficult to place. First identify the owning spine and existing workflow destination.

### 3. Make states explicit

Every meaningful surface needs intentional handling for:

- Loading and delayed network response
- Empty state with a useful next action
- Partial data and missing relationships
- Error with human-readable cause and recovery
- Permission denied and module unavailable
- Draft, pending, approved, rejected, completed, cancelled, and stale/conflicted states
- Success receipt with what changed, source, actor, and next destination

Never render blank space for an unknown state. Never show a success message when the write returned an error. Never hide a blocked action without explaining the governing reason.

### 4. Build for operational scanning

Enterprise users scan under pressure. Use:

- Strong page title and current organization/branch context
- Clear status and ownership near the record identity
- Priority and next action above secondary metadata
- Stable tables, panels, and controls that do not jump as data loads
- Concise labels with domain language users already understand
- Progressive disclosure for deep detail
- Visible timestamps, source/provenance, and freshness where relevant

Avoid decorative cards, marketing hero layouts, dense unlabeled icon fields, and dashboard decoration that competes with the operational decision.

### 5. Responsive and accessible behavior

Design desktop and mobile as intentional work surfaces, not a desktop page squeezed into a phone:

- Preserve the primary action and context on narrow screens
- Use tabs, drawers, or stacked sections when columns cannot remain readable
- Keep controls touch-sized and keyboard reachable
- Use semantic headings, labels, roles, focus states, and status announcements
- Never rely on color alone for severity, status, or permission
- Ensure long names, addresses, source filenames, and error messages wrap safely
- Test at desktop and mobile Playwright viewports

### 6. Sample data is acceptance material

Use `Build-Plan/sample data` to test realistic workflows and document handling. Start with the matrix in `docs/SAMPLE_DATA_CAPABILITY_MATRIX.md`.

For each selected file, Bob should produce:

1. File classification and sensitivity decision.
2. Expected extraction or display fields.
3. Canonical destination and governing RPC/workflow.
4. Human-review checkpoints.
5. Source-to-screen comparison evidence.
6. Exclusion/quarantine behavior where applicable.

Use files such as service agreements, assignment instructions, patrol/noise/vehicle exports, certificates, HR correspondence, invoices, and report packs to expose realistic length, ambiguity, missing values, dates, identifiers, and provenance needs. Do not treat extracted text as authoritative until a human-approved governed promotion occurs.

### 7. Atlas and schema are design inputs

Before changing a shared surface:

1. Query Atlas capability state for the page, tables, columns, RPCs, and edge functions.
2. Inspect real `reads`, `writes`, `calls`, `invokes`, and `secured_by` edges.
3. Read the owning definitions in `supabase/schema.sql` and migrations.
4. Separate proven flow reach from structural FK reach and weak references.
5. State the smallest discriminating check.
6. After the change, run the human workflow, verify persistence/error behavior, and refresh only the scoped Atlas evidence.

If Atlas and schema disagree, report the disagreement as a finding. Do not silently redesign around the map or claim an edge is live because a symbol exists in source.

### 8. Human-test acceptance

A UI is not complete because it compiles or matches a screenshot. Bob's human test must:

- Navigate through visible controls as a real user
- Type into representative fields
- Observe labels, state, density, clipping, and error clarity
- Capture desktop and mobile evidence
- Check browser console and failed requests
- Exercise safe read-only paths and controlled governed actions
- Reload and verify persistence where a write was intentionally tested
- Attach a structured report with findings, URLs, evidence, and next move

The human observer also performs a conservative visual UX audit at each
checkpoint. It records measurable findings for horizontal overflow and
clipping, page-title hierarchy, unnamed controls, missing image alt text,
sub-12px text, body contrast, large fixed overlays, dialog semantics, and
mobile viewport fit. Bob must then review the screenshot and decide whether the
finding is a real defect, an intentional design choice, or a recommendation.
The audit is evidence for human judgment, not a replacement for visual review.

For each surface, Bob should also ask:

- Is the primary action in the user's natural scan path?
- Is the information density appropriate for repeated enterprise work?
- Should this interaction remain inline, be a modal, use a drawer, or become a
	dedicated page based on task scope, context retention, and interruption cost?
- Do color, typography, imagery, iconography, and positioning communicate
	hierarchy and state without relying on decoration or color alone?
- Does the mobile layout preserve context and the next safe action?

### 10. Intentional design questions and alternatives

Bob must distinguish an intentional design decision from an accidental defect.
When a finding is ambiguous, ask the owner or product role:

- Is this density, color, font size, placement, overlay, modal, drawer, or page
	boundary intentional for a specific role and repeated workflow?
- Which user decision does the current design optimize for?
- What constraint or source requirement led to the choice?
- Is the behavior acceptable on both desktop and mobile?
- What evidence would cause us to change it?

Bob should then offer alternatives, with tradeoffs rather than preference:

| Design question | Alternative options |
|---|---|
| Small secondary information | Keep compact metadata; enlarge it; reveal on demand; move to a detail panel |
| Complex edit flow | Inline editing; focused modal; side drawer; dedicated page |
| Many navigation choices | Group by job; use progressive disclosure; add search; split by role |
| Status communication | Label plus icon; status badge plus text; timeline; queue priority |
| Large data set | Dense table; filtered queue; paginated view; virtualized list |
| Supporting visual/media | Inline preview; evidence drawer; full-screen viewer; linked source record |

For each alternative, state impact on context retention, interruption cost,
mobile behavior, accessibility, data provenance, implementation risk, and user
speed. Do not replace an intentional design merely because an automated check
reports a heuristic warning. Record the decision and rationale in the handoff
or issue packet; create a defect only when the evidence shows harm, confusion,
blocked work, accessibility failure, or incorrect data communication.

Each failure must be classified as UX, caller contract, schema/migration drift, deployment drift, authorization/RLS, unwired, unexercised, or unknown.

### 9. Web research and live truth

Use web research for questions that genuinely require current external context:
accessibility guidance, browser behavior, official platform APIs, security
standards, NZ regulatory/public-sector context, and proven enterprise SaaS
patterns. Prefer primary sources and record the URL, publisher, date, retrieval
date, and supported claim. Mark inference separately from source fact.

Use the governed `bob-query-records`, `bob-sql-read`, and `bob-schema-inspect`
paths for runtime questions: whether a record exists, which RPC signature is
deployed, whether a migration is recorded, whether a policy or grant is active,
and whether a field is populated. Keep reads scoped, redacted, and read-only;
never place service-role credentials or raw production data in prompts, browser
code, screenshots, or reports.

The evidence chain is:

```text
human observation
	-> repository/schema + Atlas inspection
	-> scoped live read verification
	-> cited web research when external context is needed
	-> smallest discriminating next move
```

Web research cannot prove a live implementation. Atlas references cannot prove
runtime flow. A live row cannot prove the schema or UI contract is correct.
Bob must state which source supports each conclusion and call out conflicts.
Writes, migrations, deployments, entitlement changes, and consequential
operational decisions remain governed actions requiring explicit approval.

## Bob's build checklist

Before implementation:

- [ ] Role, tenant, job, decision, and owning spine named.
- [ ] Atlas capability and edge evidence collected.
- [ ] Schema and migration definitions read.
- [ ] Relevant sample files selected and classified.
- [ ] States, responsive behavior, accessibility, and source provenance designed.

Before handoff:

- [ ] Real data path or governed RPC is identified.
- [ ] Loading, empty, error, permission, success, and stale states work.
- [ ] No silent writes or fake success states.
- [ ] Desktop and mobile human walkthrough completed.
- [ ] Sample source values checked against displayed/extracted values.
- [ ] Atlas/schema contradictions documented.
- [ ] External claims have primary-source citations or are labelled inference.
- [ ] Runtime claims have scoped live-read evidence or are labelled unverified.
- [ ] Sensitive sample/live data is redacted from artifacts.
- [ ] Next action and residual risk written down.

The desired result is quiet, trustworthy operational software: dense enough for repeated enterprise work, clear enough for a new operator, and honest about what is real, pending, blocked, or not yet built.
