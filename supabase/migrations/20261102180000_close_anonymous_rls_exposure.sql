-- These policies were created without a TO clause, so they applied to PUBLIC.
-- With Supabase's default anon grants, their `true` or `organization_id IS NULL`
-- arms let the anonymous key read Atlas and Bob governance tables, read org-less
-- audit rows, forge audit rows, and read or erase the invite rate-limit ledger.
-- No consumer of these tables is anonymous; every reader or writer is an
-- authenticated user or a service-role client.

ALTER POLICY "access_presets_select" ON public.access_presets TO authenticated;
ALTER POLICY "app_map_expectations_select" ON public.app_map_expectations TO authenticated;
ALTER POLICY "audit_log_select" ON public.audit_log TO authenticated;
ALTER POLICY "bob_app_map_edges_select" ON public.bob_app_map_edges TO authenticated;
ALTER POLICY "bob_capability_map_select" ON public.bob_capability_map TO authenticated;
ALTER POLICY "bob_conduct_log_insert" ON public.bob_conduct_log TO authenticated;
ALTER POLICY "bob_conduct_log_select" ON public.bob_conduct_log TO authenticated;
ALTER POLICY "bob_conduct_log_update" ON public.bob_conduct_log TO authenticated;
ALTER POLICY "bob_knowledge_cards_select" ON public.bob_knowledge_cards TO authenticated;
ALTER POLICY "bob_knowledge_cards_write" ON public.bob_knowledge_cards TO authenticated;
ALTER POLICY "bob_learnings_select" ON public.bob_learnings TO authenticated;
ALTER POLICY "bob_owner_rulings_select" ON public.bob_owner_rulings TO authenticated;
ALTER POLICY "import_code_reference_select" ON public.import_code_reference TO authenticated;
ALTER POLICY "import_code_reference_write" ON public.import_code_reference TO authenticated;
ALTER POLICY "retention_policies_select" ON public.retention_policies TO authenticated;
ALTER POLICY "retention_policies_write" ON public.retention_policies TO authenticated;
ALTER POLICY "scv_import_batches_insert" ON public.scv_import_batches TO authenticated;
ALTER POLICY "scv_import_batches_select" ON public.scv_import_batches TO authenticated;
ALTER POLICY "scv_import_batches_update" ON public.scv_import_batches TO authenticated;
ALTER POLICY "scv_import_rows_insert" ON public.scv_import_rows TO authenticated;
ALTER POLICY "scv_import_rows_select" ON public.scv_import_rows TO authenticated;
ALTER POLICY "scv_import_rows_update" ON public.scv_import_rows TO authenticated;
ALTER POLICY "Admins can view audit records for their org" ON public.user_management_audit TO authenticated;

-- audit_log is append-only and attributable. Every platform writer is a
-- SECURITY DEFINER function or a service-role client, both of which bypass RLS.
-- A direct authenticated insert may only record its own action in an organisation
-- it can access; it can no longer forge platform-level rows or another actor.
ALTER POLICY "audit_log_insert" ON public.audit_log TO authenticated
  WITH CHECK (
    organization_id IS NOT NULL
    AND org_access_allowed(organization_id)
    AND actor_user_id = (SELECT auth.uid())
  );

-- These were always meant for service_role, which bypasses RLS anyway.
-- Targeting them at it stops PUBLIC from inheriting unrestricted access.
ALTER POLICY "Service role full access on invite_rate_log" ON public.invite_rate_log TO service_role;
ALTER POLICY "Service role can insert audit records" ON public.user_management_audit TO service_role;

-- invite-org calls this rate-limit gate with the service-role client. As a
-- SECURITY DEFINER RPC that trusts its caller id, it must not be callable by
-- clients who could fill another user's or organisation's invite window.
REVOKE EXECUTE ON FUNCTION public.check_invite_rate_limit(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_invite_rate_limit(uuid, uuid) TO service_role;
