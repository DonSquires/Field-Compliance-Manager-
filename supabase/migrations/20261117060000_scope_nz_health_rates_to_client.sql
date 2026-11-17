-- Owner ruling 2026-11-17: the R & M Security "NZ Health" billing rates belong to the
-- NZ Health client. While unscoped (client_org_id NULL), location_billing_rule_applicable
-- offered them to every client place, e.g. Tasman District Council's Rabbit Island.
-- Guarded: only rules that still exist, are unscoped and belong to that provider change.
WITH scoped AS (
  UPDATE public.rate_rules rule
  SET client_org_id = '0662ad1f-dd73-43a8-8f33-807f384ab2eb'::uuid
  WHERE rule.id IN (
      'a3941e5a-4055-4dc9-b159-b8274878c2cf'::uuid,
      '004f6f8a-0556-4339-8790-ab3c8a8d6abd'::uuid)
    AND rule.organization_id = 'e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13'::uuid
    AND rule.rule_kind = 'billing'
    AND rule.client_org_id IS NULL
    AND EXISTS (
      SELECT 1 FROM public.organizations client
      WHERE client.id = '0662ad1f-dd73-43a8-8f33-807f384ab2eb'::uuid)
  RETURNING rule.id, rule.organization_id
)
INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
SELECT scoped.organization_id, NULL, 'operating_branch_rate_rule_managed', 'rate_rules', scoped.id,
  jsonb_build_object('action', 'scope_to_client', 'client_org_id', '0662ad1f-dd73-43a8-8f33-807f384ab2eb',
    'source', 'migration 20261117060000', 'reason', 'Owner ruling 2026-11-17: NZ Health rate belongs to NZ Health')
FROM scoped;
