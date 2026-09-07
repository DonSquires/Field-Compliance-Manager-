-- Owner policy: permanent interaction retention, short-lived non-interaction observations,
-- indefinite canonical identity records, and continued governed face recognition.

UPDATE public.bob_owner_rulings
SET title = 'Retention policy: permanent interactions, expiring non-interaction observations, canonical identity records',
  ruling_text = $$The owner policy for Field Compliance Manager is:

1. Interactions are retained permanently. An interaction includes an incident, field report, ticket/infringement, enforcement action, complaint, follow-up request, dispatch/re-attendance job, supervisor review, client report, evidence disclosure/export, legal hold, access/correction request, or other event that creates an operational, contractual, safety, compliance, investigative, or legal record. Interaction-linked evidence and audit/chain-of-custody records remain retained with the interaction.

2. Non-interaction observations may expire after 30 days when no ticket, incident, report, enforcement action, follow-up, review, legal hold, or other interaction has occurred. Parking observations where a vehicle photo was captured but no ticket or other interaction was issued are the canonical example. Before deletion, the system must check for links, preserve aggregate statistics only where lawful and non-identifying, record the deletion decision, and retain the deletion/audit record according to the permanent audit policy.

3. Canonical vehicle and person records are retained indefinitely. They are identity/entity records, not disposable observations. Observation rows and raw media may expire under rule 2 only when unlinked to an interaction, legal hold, or active investigation. Do not delete a canonical entity because an observation expired.

4. Face recognition remains an available capability. It is not disabled globally, but it is high-sensitivity processing: use only for an approved lawful purpose, least-privilege roles, explicit search/reason codes, confidence and provenance capture, human review, access/export logging, retention linkage, and client/privacy redaction. A face inference is never a fact by itself and must not create or merge a person record without governed human confirmation.

5. Never silently delete, overwrite, or shorten retention for an interaction. Legal holds, complaints, investigations, insurance matters, court proceedings, regulator requests, and owner-approved exceptions override ordinary expiry. Retention classification must be visible in the record and explain why it is permanent, 30-day observation-only, or held.

This owner policy controls Bob's reasoning and product recommendations. Exact legal retention periods, disclosure decisions, and face-recognition use cases still require the organisation's privacy officer or legal counsel to approve the applicable policy and jurisdiction.$$,
  domain = 'governance',
  ruling_status = 'active',
  authored_by = 'owner',
  source = 'Owner directive, 2026-09-07; applies to reporting, evidence, observations, canonical entities, retention, identity, and face recognition',
  updated_at = now()
WHERE ruling_key = 'retention_interaction_vs_observation_identity_policy';

INSERT INTO public.bob_owner_rulings (
  ruling_key,
  title,
  ruling_text,
  domain,
  ruling_status,
  authored_by,
  source
)
SELECT
  'retention_interaction_vs_observation_identity_policy',
  'Retention policy: permanent interactions, expiring non-interaction observations, canonical identity records',
  $$The owner policy for Field Compliance Manager is:

1. Interactions are retained permanently. An interaction includes an incident, field report, ticket/infringement, enforcement action, complaint, follow-up request, dispatch/re-attendance job, supervisor review, client report, evidence disclosure/export, legal hold, access/correction request, or other event that creates an operational, contractual, safety, compliance, investigative, or legal record. Interaction-linked evidence and audit/chain-of-custody records remain retained with the interaction.

2. Non-interaction observations may expire after 30 days when no ticket, incident, report, enforcement action, follow-up, review, legal hold, or other interaction has occurred. Parking observations where a vehicle photo was captured but no ticket or other interaction was issued are the canonical example. Before deletion, the system must check for links, preserve aggregate statistics only where lawful and non-identifying, record the deletion decision, and retain the deletion/audit record according to the permanent audit policy.

3. Canonical vehicle and person records are retained indefinitely. They are identity/entity records, not disposable observations. Observation rows and raw media may expire under rule 2 only when unlinked to an interaction, legal hold, or active investigation. Do not delete a canonical entity because an observation expired.

4. Face recognition remains an available capability. It is not disabled globally, but it is high-sensitivity processing: use only for an approved lawful purpose, least-privilege roles, explicit search/reason codes, confidence and provenance capture, human review, access/export logging, retention linkage, and client/privacy redaction. A face inference is never a fact by itself and must not create or merge a person record without governed human confirmation.

5. Never silently delete, overwrite, or shorten retention for an interaction. Legal holds, complaints, investigations, insurance matters, court proceedings, regulator requests, and owner-approved exceptions override ordinary expiry. Retention classification must be visible in the record and explain why it is permanent, 30-day observation-only, or held.

This owner policy controls Bob's reasoning and product recommendations. Exact legal retention periods, disclosure decisions, and face-recognition use cases still require the organisation's privacy officer or legal counsel to approve the applicable policy and jurisdiction.$$,
  'governance',
  'active',
  'owner',
  'Owner directive, 2026-09-07; applies to reporting, evidence, observations, canonical entities, retention, identity, and face recognition'
WHERE NOT EXISTS (
  SELECT 1 FROM public.bob_owner_rulings
  WHERE ruling_key = 'retention_interaction_vs_observation_identity_policy'
    AND ruling_status = 'active'
);
