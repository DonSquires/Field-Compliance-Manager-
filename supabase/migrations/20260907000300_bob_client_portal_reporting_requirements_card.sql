-- Keep client portal/reporting requirements as dynamic Bob knowledge, not code prompts.

INSERT INTO public.bob_knowledge_cards (
  organization_id,
  category,
  key,
  title,
  content,
  tags,
  source,
  is_active
)
SELECT
  NULL,
  'reporting',
  'client_portal_reporting_requirements',
  'Client portal and reporting requirements: define the client data contract before activation',
  $$PURPOSE

Before activating an agreement or configuring a module, establish what the client expects to see in the portal and reports. The portal is a contract surface: its visible fields, access mode, report templates, delivery cadence, and evidence level must match the agreement and the client''s source documents.

DISCOVER THE CLIENT DATA CONTRACT

Extract and confirm: portal access mode (transparency-only, full modules, scan-only, or other governed mode), whether reports are enabled, report template/code, reporting period, delivery schedule, recipients, modules included, places/zones included, KPIs, exception thresholds, incident/escalation fields, evidence visibility, privacy redactions, follow-up status, and invoice/commercial visibility. Do not infer these from a generic module name.

MINIMUM OPERATIONAL REPORT MODEL

For each covered module, define the chain:
requirement -> agreement scope -> site/zone -> scheduled work or dispatch job -> officer action -> evidence -> inference/review -> compliance outcome -> client report.
A report should be able to show the covered period, places and zones, planned versus completed work, observations, repeated vehicle/person review keys where lawful, compliant/at-risk/breach counts, incidents and escalation status, follow-up actions, evidence references, review decisions, and unresolved data gaps.

MODULE-SPECIFIC EXPECTATIONS

- Parking: zone, restriction/time limit, patrol/chalk event, first and return observations, movement/overstay outcome, signage/ALPR evidence, warden/warrant context, infringement or warning status, and repeat vehicle counts.
- Freedom camping/patrol: evening/morning scan pairing, verified overnight result, zone rule, SCV result, breach reason, checkpoint/route attendance, and exception review.
- Noise: complaint/source place distinction, attend/assess/action/follow-up stages, volume/time/tone assessment, notice or seizure decision, police involvement where applicable, and response SLA.
- Smoke: complaint/source place, assessment, photo evidence, out-of-hours response, action/follow-up, review state, and environmental outcome.
- Biosecurity: observed source place versus protected land, pest/species evidence, density, photo/inference result, action/referral/notice number, follow-up, review decision, and evidence provenance.
- Incident/person/vehicle: incident id, related person and vehicle entities only where explicitly linked or human-confirmed, source photo/video, OCR/ALPR/face inference confidence, reviewer decision, and privacy/retention state. Never expose raw biometric data to a client portal by default.

CONFIGURE BEFORE ACTIVATION

Persist the client''s selected report contract in the governed agreement reporting setup: enabled modules, authorized sites/zones, report templates, report fields/metrics, cadence, recipients, portal access mode, and evidence/privacy rules. If a requested metric cannot be produced by live data, mark it as a blocker or provisional field rather than promising it. A service agreement is not ready for review until its required reporting controls and templates exist.

REPORT GENERATION AND REVIEW

Generate reports only from live governed records. Reconcile counts against observations, dispatch/roster completion, field reports, incidents, evidence items, inference jobs/results, and review decisions. Show source period, generated status, sent status, delivery errors, and who reviewed or approved the report. Keep draft, generated, sent, failed, and superseded versions distinct.

CLIENT PORTAL UX CHECK

Walk the portal as the client: select the intended agreement, verify only authorized sites/zones appear, confirm empty states are honest, check that report and observation filters agree with the agreement scope, ensure incident/evidence privacy is respected, and test whether a client can understand what happened, where, when, why, and what remains unresolved. If a menu promises data that the agreement or live records cannot supply, fix the configuration or show a clear unavailable state.

PROVENANCE AND GAP REPORTING

Every client-visible metric must be traceable to source requirements and live records. Include a report data dictionary or configuration note for derived metrics such as repeat vehicle count, first/last observed, SLA compliance, breach rate, and follow-up overdue. Distinguish no data, not authorized, not configured, not yet reviewed, and genuinely zero. Never turn a missing record into a zero.

CLOSE THE LOOP

After configuring reporting, read the agreement setup and portal as a client, generate a test report for a known period, verify its data against source records, and record any gaps before activation. After real operations begin, monitor report generation, delivery, client access, and review feedback as part of the operational handoff.$$,
  ARRAY['client_portal', 'reporting', 'agreement', 'observations', 'incidents', 'evidence', 'privacy', 'parking', 'freedom_camping', 'noise', 'smoke', 'biosecurity'],
  'Owner-authored dynamic reporting method based on the live client portal contract and uploaded client procurement/RFQ/RFP/RFIP materials. Must be reconciled with the live agreement reporting setup and governed report records.',
  TRUE
WHERE NOT EXISTS (
  SELECT 1
  FROM public.bob_knowledge_cards
  WHERE organization_id IS NULL
    AND key = 'client_portal_reporting_requirements'
    AND is_active = TRUE
);
