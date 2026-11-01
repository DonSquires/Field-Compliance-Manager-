-- Organisation-scoped policies evaluate the caller's reach once per statement.
--
-- 357 row-level security policies on 257 tables called
-- org_access_allowed(<column>) for every candidate row. That helper is a
-- SECURITY DEFINER function, so Postgres cannot inline it, and each call
-- re-runs up to five sub-queries (membership, descendant organisations,
-- provider/client grants and operational agreements). Live timings before this
-- change: an admin officer counting bob_event_log took ~20s (past the 8s
-- authenticated statement timeout), bob_messages ~5.8s and observations ~4.3s;
-- the anonymous key spent 1.3-4.2s on the same tables to return no rows. In a
-- rollback rehearsal of this migration the same reads took 3-29 ms.
--
-- The caller's reach does not depend on the row, so accessible_org_ids()
-- returns the whole set once. Every policy call org_access_allowed(X) becomes
--   ((SELECT is_grand_master()) OR COALESCE((X) = ANY ((SELECT accessible_org_ids())::uuid[]), false))
-- Both scalar sub-selects are uncorrelated, so each runs once per statement as
-- an initPlan and every row costs one array comparison. The ::uuid[] cast makes
-- Postgres read the sub-select as one array value rather than an ANY sub-link
-- over rows; parse analysis strips it, and pg_dump prints it back the same way.
-- The result is the same strict boolean org_access_allowed returns, including
-- false for a NULL X.
--
-- Equivalence, checked live inside rolled-back transactions:
--   * the two forms agree for all 69 user profiles (every role, active and
--     deactivated), an unknown uid and the anonymous key, against every
--     organisation, a NULL target and an unknown id: 0 differences;
--   * visible row counts and row-identity hashes match before and after on
--     every rewritten table for a narrow-reach officer, and on table slices
--     for a wide-reach officer and a master: 0 differences.
--
-- org_access_allowed stays for function bodies and single-row checks.
-- accessible_org_ids() must stay equivalent to it: change both together.
-- Policies in the storage schema are not rewritten here.

-- Each rewritten table stays locked ACCESS EXCLUSIVE until this transaction
-- ends, and a lock request waiting behind a long-running read makes every
-- later read of that table queue behind it. Fail fast instead: the release
-- lane leaves a failed migration unledgered and retries it on its next tick.
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.accessible_org_ids()
RETURNS uuid[]
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  select coalesce(array_agg(distinct reach.org_id) filter (where reach.org_id is not null), array[]::uuid[])
  from user_profiles p
  cross join lateral (
    select p.organization_id
    union all
    select unnest(p.authorized_organization_ids)
    union all
    select unnest(get_descendant_organizations(p.organization_id))
     where p.role in ('grand_master', 'master', 'admin', 'admin_officer')
    union all
    select unnest(get_descendant_organizations(p.employer_organization_id))
     where p.role in ('grand_master', 'master', 'admin', 'admin_officer')
       and p.employer_organization_id is not null
    union all
    select unnest(array[g.provider_organization_id, g.client_organization_id])
      from provider_client_access_grants g
     where (p.organization_id = g.provider_organization_id or p.organization_id = g.client_organization_id)
       and (g.ends_at is null or g.ends_at > now())
    union all
    select sa.client_organization_id
      from service_agreements sa
     where (sa.ends_on is null or sa.ends_on >= current_date)
       and sa.agreement_type = 'operational'
       and (p.organization_id = sa.provider_organization_id
            or p.employer_organization_id = sa.provider_organization_id)
    union all
    select sa.provider_organization_id
      from service_agreements sa
     where (sa.ends_on is null or sa.ends_on >= current_date)
       and sa.agreement_type = 'operational'
       and (p.organization_id = sa.client_organization_id
            or p.employer_organization_id = sa.client_organization_id)
  ) as reach(org_id)
  where p.id = auth.uid()
    and p.deactivated_at is null;
$function$;

COMMENT ON FUNCTION public.accessible_org_ids() IS
  'Set form of org_access_allowed for row-level security: the organisations the caller may reach, computed once per statement. Must stay equivalent to org_access_allowed(target) for every target; change both together.';

COMMENT ON FUNCTION public.org_access_allowed(uuid) IS
  'Single-target organisation reach check. Row-level security policies use the initPlan form with accessible_org_ids(), which must stay equivalent; change both together.';

-- PUBLIC-role policies are evaluated as anon too, so anon needs EXECUTE; it
-- only ever returns the caller's own reach, which is empty for anon.
REVOKE ALL ON FUNCTION public.accessible_org_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.accessible_org_ids() TO anon, authenticated, service_role;

ALTER POLICY "agreement_obligations_select" ON public."agreement_obligations"
  USING ((EXISTS ( SELECT 1
   FROM service_agreements s
  WHERE ((s.id = agreement_obligations.service_agreement_id) AND (((SELECT public.is_grand_master()) OR COALESCE((s.provider_organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)) OR ((SELECT public.is_grand_master()) OR COALESCE((s.client_organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)))))));

ALTER POLICY "alarm_events_insert" ON public."alarm_events"
  WITH CHECK (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "alarm_events_select" ON public."alarm_events"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "asset_checks_select" ON public."asset_checks"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "assets_select" ON public."assets"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "audit_log_insert" ON public."audit_log"
  WITH CHECK (((organization_id IS NOT NULL) AND ((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)) AND (actor_user_id = ( SELECT auth.uid() AS uid))));

ALTER POLICY "audit_log_select" ON public."audit_log"
  USING ((((organization_id IS NOT NULL) AND ((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false))) OR ((organization_id IS NULL) AND (( SELECT is_grand_master() AS is_grand_master) OR ( SELECT is_platform_owner(( SELECT auth.uid() AS uid)) AS is_platform_owner)))));

ALTER POLICY "bank_accounts_select" ON public."bank_accounts"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "bae_select" ON public."biosecurity_assessment_evidence"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "ba_insert" ON public."biosecurity_assessments"
  WITH CHECK (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "ba_select" ON public."biosecurity_assessments"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "ba_update" ON public."biosecurity_assessments"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)))
  WITH CHECK (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "biosecurity_assessments_select" ON public."biosecurity_assessments"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "baa_insert" ON public."bob_agentic_actions"
  WITH CHECK (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "baa_select" ON public."bob_agentic_actions"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "baa_update" ON public."bob_agentic_actions"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)))
  WITH CHECK (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "bob_attachments_insert" ON public."bob_attachments"
  WITH CHECK ((((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)) AND ((purpose <> 'identity_document'::text) OR is_admin_for_org(organization_id))));

ALTER POLICY "bob_attachments_select" ON public."bob_attachments"
  USING ((((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)) AND ((purpose <> 'identity_document'::text) OR (is_admin_for_org(organization_id) AND (NOT nzta_attachment_restricted(id))))));

ALTER POLICY "bob_attachments_update" ON public."bob_attachments"
  USING ((((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)) AND ((purpose <> 'identity_document'::text) OR is_admin_for_org(organization_id))))
  WITH CHECK ((((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)) AND ((purpose <> 'identity_document'::text) OR is_admin_for_org(organization_id))));

ALTER POLICY "bob_conduct_log_insert" ON public."bob_conduct_log"
  WITH CHECK (((organization_id IS NOT NULL) AND ((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)) AND is_admin_for_org(organization_id)));

ALTER POLICY "bob_conduct_log_select" ON public."bob_conduct_log"
  USING (((organization_id IS NULL) OR (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)) AND ((subject_user_id = auth.uid()) OR is_admin_for_org(organization_id)))));

ALTER POLICY "bob_conduct_log_update" ON public."bob_conduct_log"
  USING (((organization_id IS NOT NULL) AND ((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)) AND is_admin_for_org(organization_id)))
  WITH CHECK (((organization_id IS NOT NULL) AND ((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)) AND is_admin_for_org(organization_id)));

ALTER POLICY "bcm_insert" ON public."bob_context_memory"
  WITH CHECK (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "bcm_select" ON public."bob_context_memory"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "bcm_update" ON public."bob_context_memory"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)))
  WITH CHECK (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "bob_conversation_facts_insert" ON public."bob_conversation_facts"
  WITH CHECK (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "bob_conversation_facts_select" ON public."bob_conversation_facts"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "bob_conversation_facts_update" ON public."bob_conversation_facts"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)))
  WITH CHECK (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "bob_conversations_insert" ON public."bob_conversations"
  WITH CHECK (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "bob_conversations_select" ON public."bob_conversations"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "bob_conversations_update" ON public."bob_conversations"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)))
  WITH CHECK (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "bob_event_log_insert" ON public."bob_event_log"
  WITH CHECK (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "bob_event_log_select" ON public."bob_event_log"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "bob_friction_packets_review_update" ON public."bob_friction_packets"
  USING ((((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)) AND (is_grand_master() OR is_admin_for_org(organization_id))))
  WITH CHECK ((((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)) AND (is_grand_master() OR is_admin_for_org(organization_id))));

ALTER POLICY "bob_friction_packets_select" ON public."bob_friction_packets"
  USING ((((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)) AND ((user_id = auth.uid()) OR is_grand_master() OR is_admin_for_org(organization_id))));

ALTER POLICY "bob_generated_document_outputs_select" ON public."bob_generated_document_outputs"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "bjps_insert" ON public."bob_job_plan_steps"
  WITH CHECK ((EXISTS ( SELECT 1
   FROM bob_job_plans p
  WHERE ((p.id = bob_job_plan_steps.plan_id) AND ((SELECT public.is_grand_master()) OR COALESCE((p.organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false))))));

ALTER POLICY "bjps_select" ON public."bob_job_plan_steps"
  USING ((EXISTS ( SELECT 1
   FROM bob_job_plans p
  WHERE ((p.id = bob_job_plan_steps.plan_id) AND ((SELECT public.is_grand_master()) OR COALESCE((p.organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false))))));

ALTER POLICY "bjps_update" ON public."bob_job_plan_steps"
  USING ((EXISTS ( SELECT 1
   FROM bob_job_plans p
  WHERE ((p.id = bob_job_plan_steps.plan_id) AND ((SELECT public.is_grand_master()) OR COALESCE((p.organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false))))))
  WITH CHECK ((EXISTS ( SELECT 1
   FROM bob_job_plans p
  WHERE ((p.id = bob_job_plan_steps.plan_id) AND ((SELECT public.is_grand_master()) OR COALESCE((p.organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false))))));

ALTER POLICY "bjp_insert" ON public."bob_job_plans"
  WITH CHECK (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "bjp_select" ON public."bob_job_plans"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "bjp_update" ON public."bob_job_plans"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)))
  WITH CHECK (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "bob_job_rollback_refs_select" ON public."bob_job_rollback_refs"
  USING (((EXISTS ( SELECT 1
   FROM user_profiles up
  WHERE ((up.id = ( SELECT auth.uid() AS uid)) AND (up.deactivated_at IS NULL) AND (up.role = ANY (ARRAY['grand_master'::text, 'master'::text, 'admin'::text, 'admin_officer'::text]))))) AND (EXISTS ( SELECT 1
   FROM bob_job_runs run
  WHERE ((run.job_id = bob_job_rollback_refs.job_id) AND (run.organization_id IS NOT NULL) AND ((SELECT public.is_grand_master()) OR COALESCE((run.organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)))))));

ALTER POLICY "bob_job_runs_select" ON public."bob_job_runs"
  USING (((EXISTS ( SELECT 1
   FROM user_profiles up
  WHERE ((up.id = ( SELECT auth.uid() AS uid)) AND (up.deactivated_at IS NULL) AND (up.role = ANY (ARRAY['grand_master'::text, 'master'::text, 'admin'::text, 'admin_officer'::text]))))) AND (((organization_id IS NOT NULL) AND ((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false))) OR is_grand_master())));

ALTER POLICY "bob_knowledge_cards_select" ON public."bob_knowledge_cards"
  USING (((organization_id IS NULL) OR ((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false))));

ALTER POLICY "bob_learning_memory_select" ON public."bob_learning_memory"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "bob_message_feedback_delete" ON public."bob_message_feedback"
  USING ((((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)) AND (user_id = auth.uid())));

ALTER POLICY "bob_message_feedback_insert" ON public."bob_message_feedback"
  WITH CHECK ((((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)) AND (user_id = auth.uid())));

ALTER POLICY "bob_message_feedback_select" ON public."bob_message_feedback"
  USING ((((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)) AND ((user_id = auth.uid()) OR is_admin_for_org(organization_id))));

ALTER POLICY "bob_message_feedback_update" ON public."bob_message_feedback"
  USING ((((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)) AND (user_id = auth.uid())))
  WITH CHECK ((((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)) AND (user_id = auth.uid())));

ALTER POLICY "bob_messages_insert" ON public."bob_messages"
  WITH CHECK (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "bob_messages_select" ON public."bob_messages"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "bob_nz_finance_readiness_checks_select" ON public."bob_nz_finance_readiness_checks"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "bob_turn_runs_select_own" ON public."bob_turn_runs"
  USING (((( SELECT auth.uid() AS uid) = user_id) AND ((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false))));

ALTER POLICY "boundary_proposals_select" ON public."boundary_proposals"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "breach_alerts_client_org_select" ON public."breach_alerts"
  USING (((SELECT public.is_grand_master()) OR COALESCE((client_org_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "breach_alerts_insert" ON public."breach_alerts"
  WITH CHECK (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "breach_alerts_select" ON public."breach_alerts"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "breach_records_insert" ON public."breach_records"
  WITH CHECK (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "breach_records_select" ON public."breach_records"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "breach_records_update" ON public."breach_records"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)))
  WITH CHECK (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "callout_shifts_select" ON public."callout_shifts"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "canonical_person_links_select" ON public."canonical_person_links"
  USING (((organization_id IS NULL) OR ((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false))));

ALTER POLICY "canonical_place_links_select" ON public."canonical_place_links"
  USING (((organization_id IS NULL) OR ((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false))));

ALTER POLICY "cctv_camera_scene_profiles_select" ON public."cctv_camera_scene_profiles"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "cctv_cloud_inference_receipts_select" ON public."cctv_cloud_inference_receipts"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "cctv_entity_observations_select" ON public."cctv_entity_observations"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "cctv_exports_select" ON public."cctv_exports"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "cctv_identity_drafts_insert" ON public."cctv_identity_drafts"
  WITH CHECK ((((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)) AND (created_by = auth.uid())));

ALTER POLICY "cctv_identity_drafts_select" ON public."cctv_identity_drafts"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "cctv_identity_drafts_update" ON public."cctv_identity_drafts"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)))
  WITH CHECK (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "cctv_imports_select" ON public."cctv_imports"
  USING ((((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)) OR (EXISTS ( SELECT 1
   FROM locations l
  WHERE ((l.id = cctv_imports.location_id) AND ((SELECT public.is_grand_master()) OR COALESCE((l.organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)))))));

ALTER POLICY "cctv_inference_budgets_select" ON public."cctv_inference_budgets"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "cctv_inference_policies_select" ON public."cctv_inference_policies"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "cctv_missed_detection_reports_select" ON public."cctv_missed_detection_reports"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "cctv_observation_derivatives_select" ON public."cctv_observation_derivatives"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "cctv_report_receipts_select" ON public."cctv_report_receipts"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "cctv_resident_objects_select" ON public."cctv_resident_objects"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "cctv_review_decisions_insert" ON public."cctv_review_decisions"
  WITH CHECK ((((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)) AND (decided_by = auth.uid())));

ALTER POLICY "cctv_review_decisions_select" ON public."cctv_review_decisions"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "cctv_review_event_decisions_select" ON public."cctv_review_event_decisions"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "cctv_review_events_select" ON public."cctv_review_events"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "cspc_select" ON public."client_site_patrol_config"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "client_sites_select" ON public."client_sites"
  USING (((SELECT public.is_grand_master()) OR COALESCE((client_organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "commercial_discount_schedule_rules_select" ON public."commercial_discount_schedule_rules"
  USING ((EXISTS ( SELECT 1
   FROM commercial_discount_schedules schedule
  WHERE ((schedule.id = commercial_discount_schedule_rules.schedule_id) AND ((SELECT public.is_grand_master()) OR COALESCE((schedule.provider_organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false))))));

ALTER POLICY "commercial_discount_schedules_select" ON public."commercial_discount_schedules"
  USING (((SELECT public.is_grand_master()) OR COALESCE((provider_organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "cost_centres_select" ON public."cost_centres"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "crm_commercial_settings_select" ON public."crm_commercial_settings"
  USING ((EXISTS ( SELECT 1
   FROM service_agreements s
  WHERE ((s.id = crm_commercial_settings.service_agreement_id) AND (((SELECT public.is_grand_master()) OR COALESCE((s.provider_organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)) OR ((SELECT public.is_grand_master()) OR COALESCE((s.client_organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)))))));

ALTER POLICY "crm_contacts_select" ON public."crm_contacts"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "crm_jurisdiction_configs_select" ON public."crm_jurisdiction_configs"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "crm_onboarding_ledgers_select" ON public."crm_onboarding_ledgers"
  USING (((SELECT public.is_grand_master()) OR COALESCE((provider_organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "custodian_actions_select" ON public."custodian_actions"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "custodian_legal_holds_select" ON public."custodian_legal_holds"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "dispatch_job_charge_lines_select" ON public."dispatch_job_charge_lines"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "dispatch_jobs_insert" ON public."dispatch_jobs"
  WITH CHECK (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "dispatch_jobs_select" ON public."dispatch_jobs"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "dispatch_jobs_update" ON public."dispatch_jobs"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)))
  WITH CHECK (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "dispatch_resources_select" ON public."dispatch_resources"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "disputes_select" ON public."disputes"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "document_classifications_select" ON public."document_classifications"
  USING ((EXISTS ( SELECT 1
   FROM (document_versions v
     JOIN documents d ON ((d.id = v.document_id)))
  WHERE ((v.id = document_classifications.document_version_id) AND (((d.organization_id IS NULL) AND (d.current_scope = 'global_reference'::text)) OR ((SELECT public.is_grand_master()) OR COALESCE((d.organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)))))));

ALTER POLICY "document_promotion_proposals_select" ON public."document_promotion_proposals"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "document_reference_sources_select" ON public."document_reference_sources"
  USING ((((organization_id IS NULL) AND (approval_status = 'approved'::text)) OR ((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false))));

ALTER POLICY "document_upload_events_select" ON public."document_upload_events"
  USING ((((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)) OR is_grand_master()));

ALTER POLICY "ems_alerts_select" ON public."ems_alerts"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "ems_device_checks_select" ON public."ems_device_checks"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "ems_devices_select" ON public."ems_devices"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "enforcement_case_events_select" ON public."enforcement_case_events"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "enforcement_cases_select" ON public."enforcement_cases"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "entity_flags_select" ON public."entity_flags"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "entity_flags_write" ON public."entity_flags"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)))
  WITH CHECK (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "entity_links_select" ON public."entity_links"
  USING ((((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)) AND ((relationship <> ALL (ARRAY['owner'::text, 'registered_owner'::text, 'driver'::text, 'associated_person'::text])) OR (can_access_vehicle_owner_identity(organization_id) AND can_access_person_contacts(organization_id) AND ((NOT COALESCE(((evidence ->> 'nzta_restricted'::text))::boolean, false)) OR ((to_type = 'vehicle'::text) AND nzta_reveal_active(ARRAY[organization_id], 'vehicle'::text, to_id)) OR ((from_type = 'person'::text) AND nzta_reveal_active(ARRAY[organization_id], 'person'::text, from_id)))))));

ALTER POLICY "entity_links_write" ON public."entity_links"
  USING ((((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)) AND (relationship <> ALL (ARRAY['owner'::text, 'registered_owner'::text, 'driver'::text, 'associated_person'::text]))))
  WITH CHECK ((((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)) AND (relationship <> ALL (ARRAY['owner'::text, 'registered_owner'::text, 'driver'::text, 'associated_person'::text]))));

ALTER POLICY "event_context_snapshots_select" ON public."event_context_snapshots"
  USING (((SELECT public.is_grand_master()) OR COALESCE((COALESCE(provider_organization_id, client_organization_id, jurisdiction_organization_id)) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "evidence_items_insert" ON public."evidence_items"
  WITH CHECK (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "evidence_items_select" ON public."evidence_items"
  USING ((((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)) AND ((module_key IS DISTINCT FROM 'identity_registry'::text) OR (NOT nzta_evidence_restricted(id)))));

ALTER POLICY "esa_org_select" ON public."evidence_summary_approvals"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "face_observations_select" ON public."face_observations"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "finance_akahu_apply_applications_select" ON public."finance_akahu_apply_applications"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "finance_akahu_apply_reports_select" ON public."finance_akahu_apply_reports"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "finance_akahu_apply_sharing_requests_select" ON public."finance_akahu_apply_sharing_requests"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "finance_akahu_apply_transaction_reviews_select" ON public."finance_akahu_apply_transaction_reviews"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "finance_akahu_personal_checks_select" ON public."finance_akahu_personal_checks"
  USING ((is_grand_master() AND ((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false))));

ALTER POLICY "finance_asset_cost_profiles_select" ON public."finance_asset_cost_profiles"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "finance_asset_depreciation_schedules_select" ON public."finance_asset_depreciation_schedules"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "finance_asset_item_links_select" ON public."finance_asset_item_links"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "finance_bank_statement_lines_select" ON public."finance_bank_statement_lines"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "finance_bank_statements_select" ON public."finance_bank_statements"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "finance_budget_lines_select" ON public."finance_budget_lines"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "finance_budget_variances_select" ON public."finance_budget_variances"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "finance_budgets_select" ON public."finance_budgets"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "finance_cost_assumptions_select" ON public."finance_cost_assumptions"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "finance_cost_categories_select" ON public."finance_cost_categories"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "finance_cost_centre_rolls_select" ON public."finance_cost_centre_rolls"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "finance_cost_variance_select" ON public."finance_cost_variance"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "finance_external_bank_transactions_select" ON public."finance_external_bank_transactions"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "finance_external_connection_requests_select" ON public."finance_external_connection_requests"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "finance_inventory_balances_select" ON public."finance_inventory_balances"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "finance_inventory_locations_select" ON public."finance_inventory_locations"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "finance_inventory_transactions_select" ON public."finance_inventory_transactions"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "finance_item_catalog_select" ON public."finance_item_catalog"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "finance_item_cost_versions_select" ON public."finance_item_cost_versions"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "finance_item_price_versions_select" ON public."finance_item_price_versions"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "finance_labour_cost_postings_select" ON public."finance_labour_cost_postings"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "finance_payday_filing_packages_select" ON public."finance_payday_filing_packages"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "finance_pl_periods_select" ON public."finance_pl_periods"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "finance_pl_snapshots_select" ON public."finance_pl_snapshots"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "finance_provisional_tax_plans_select" ON public."finance_provisional_tax_plans"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "finance_service_costs_select" ON public."finance_service_costs"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "finance_service_item_consumption_select" ON public."finance_service_item_consumption"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "finance_service_profitability_select" ON public."finance_service_profitability"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "finance_tax_periods_select" ON public."finance_tax_periods"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "finance_tax_transactions_select" ON public."finance_tax_transactions"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "finance_variance_exceptions_select" ON public."finance_variance_exceptions"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "fda_org_select" ON public."formal_decision_approvals"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "fdr_org_select" ON public."formal_decision_records"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "freedom_camping_org_settings_select" ON public."freedom_camping_org_settings"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "fuel_price_observations_select" ON public."fuel_price_observations"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "fuel_price_sources_select" ON public."fuel_price_sources"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "gbh_select" ON public."geofence_boundary_history"
  USING (
CASE entity_type
    WHEN 'organization'::text THEN ((SELECT public.is_grand_master()) OR COALESCE((entity_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false))
    WHEN 'location_zone'::text THEN ((SELECT public.is_grand_master()) OR COALESCE((( SELECT location_zones.organization_id
       FROM location_zones
      WHERE (location_zones.id = geofence_boundary_history.entity_id))) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false))
    WHEN 'client_site'::text THEN ((SELECT public.is_grand_master()) OR COALESCE((( SELECT client_sites.client_organization_id
       FROM client_sites
      WHERE (client_sites.id = geofence_boundary_history.entity_id))) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false))
    ELSE false
END);

ALTER POLICY "homeless_claims_insert" ON public."homeless_claims"
  WITH CHECK (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "homeless_claims_select" ON public."homeless_claims"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "import_code_reference_select" ON public."import_code_reference"
  USING (((organization_id IS NULL) OR ((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false))));

ALTER POLICY "import_org_aliases_select" ON public."import_org_aliases"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "import_org_aliases_write" ON public."import_org_aliases"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)))
  WITH CHECK (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "import_place_aliases_select" ON public."import_place_aliases"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "import_place_aliases_write" ON public."import_place_aliases"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)))
  WITH CHECK (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "incident_attachments_select" ON public."incident_attachments"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "incidents_insert" ON public."incidents"
  WITH CHECK (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "incidents_select" ON public."incidents"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "incidents_update" ON public."incidents"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)))
  WITH CHECK (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "inference_jobs_select" ON public."inference_jobs"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "inference_results_select" ON public."inference_results"
  USING ((EXISTS ( SELECT 1
   FROM evidence_items e
  WHERE ((e.id = inference_results.evidence_item_id) AND ((SELECT public.is_grand_master()) OR COALESCE((e.organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false))))));

ALTER POLICY "infringement_notices_select" ON public."infringement_notices"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "invoice_adjustments_select" ON public."invoice_adjustments"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "ili_insert" ON public."invoice_line_items"
  WITH CHECK ((EXISTS ( SELECT 1
   FROM invoices i
  WHERE ((i.id = invoice_line_items.invoice_id) AND ((SELECT public.is_grand_master()) OR COALESCE((i.organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false))))));

ALTER POLICY "ili_select" ON public."invoice_line_items"
  USING ((EXISTS ( SELECT 1
   FROM invoices i
  WHERE ((i.id = invoice_line_items.invoice_id) AND ((SELECT public.is_grand_master()) OR COALESCE((i.organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false))))));

ALTER POLICY "invoice_line_items_select" ON public."invoice_line_items"
  USING ((EXISTS ( SELECT 1
   FROM invoices i
  WHERE ((i.id = invoice_line_items.invoice_id) AND (((SELECT public.is_grand_master()) OR COALESCE((i.organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)) OR ((SELECT public.is_grand_master()) OR COALESCE((i.client_organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)))))));

ALTER POLICY "ilt_select" ON public."invoice_line_templates"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "invoices_select" ON public."invoices"
  USING ((((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)) OR ((SELECT public.is_grand_master()) OR COALESCE((client_organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false))));

ALTER POLICY "org_access_invoices" ON public."invoices"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "jurisdiction_rule_sets_select" ON public."jurisdiction_rule_sets"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "jto_org_select" ON public."jurisdiction_template_overrides"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "key_audit_settings_select" ON public."key_audit_settings"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "key_sets_select" ON public."key_sets"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "loc_events_insert" ON public."location_events"
  WITH CHECK (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "loc_events_select" ON public."location_events"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "loc_events_update" ON public."location_events"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)))
  WITH CHECK (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "location_module_assignments_select" ON public."location_module_assignments"
  USING (((SELECT public.is_grand_master()) OR COALESCE((( SELECT l.organization_id
   FROM locations l
  WHERE (l.id = location_module_assignments.location_id))) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "location_zones_select" ON public."location_zones"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "locations_select" ON public."locations"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "module_rule_sets_select" ON public."module_rule_sets"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "na_insert" ON public."noise_assessments"
  WITH CHECK (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "na_select" ON public."noise_assessments"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "na_update" ON public."noise_assessments"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)))
  WITH CHECK (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "noise_assessments_select" ON public."noise_assessments"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "nmc_select" ON public."noise_module_config"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "noise_seizures_select" ON public."noise_seizures"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "ns_insert" ON public."noise_seizures"
  WITH CHECK ((EXISTS ( SELECT 1
   FROM noise_assessments na
  WHERE ((na.id = noise_seizures.noise_assessment_id) AND ((SELECT public.is_grand_master()) OR COALESCE((na.organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false))))));

ALTER POLICY "ns_select" ON public."noise_seizures"
  USING ((EXISTS ( SELECT 1
   FROM noise_assessments na
  WHERE ((na.id = noise_seizures.noise_assessment_id) AND ((SELECT public.is_grand_master()) OR COALESCE((na.organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false))))));

ALTER POLICY "ns_update" ON public."noise_seizures"
  USING ((EXISTS ( SELECT 1
   FROM noise_assessments na
  WHERE ((na.id = noise_seizures.noise_assessment_id) AND ((SELECT public.is_grand_master()) OR COALESCE((na.organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false))))));

ALTER POLICY "notice_templates_select" ON public."notice_templates"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "notices_insert" ON public."notices"
  WITH CHECK (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "notices_select" ON public."notices"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "notices_update" ON public."notices"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)))
  WITH CHECK (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "notices_to_vacate_select" ON public."notices_to_vacate"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "notifications_select" ON public."notifications"
  USING ((((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)) AND ((recipient_user_id = auth.uid()) OR ((recipient_user_id IS NULL) AND ((recipient_role = current_user_role()) OR ((recipient_role = 'admin'::text) AND (current_user_role() = 'admin_officer'::text)))))));

ALTER POLICY "notifications_update" ON public."notifications"
  USING ((((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)) AND ((recipient_user_id = auth.uid()) OR ((recipient_user_id IS NULL) AND ((recipient_role = current_user_role()) OR ((recipient_role = 'admin'::text) AND (current_user_role() = 'admin_officer'::text)))))))
  WITH CHECK ((((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)) AND ((recipient_user_id = auth.uid()) OR ((recipient_user_id IS NULL) AND ((recipient_role = current_user_role()) OR ((recipient_role = 'admin'::text) AND (current_user_role() = 'admin_officer'::text)))))));

ALTER POLICY "nzscv_records_select" ON public."nzscv_records"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "observation_person_mentions_select" ON public."observation_person_mentions"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "observation_supporting_evidence_insert" ON public."observation_supporting_evidence"
  WITH CHECK (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "observation_supporting_evidence_select" ON public."observation_supporting_evidence"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "observation_supporting_evidence_update" ON public."observation_supporting_evidence"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)))
  WITH CHECK (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "observations_client_org_select" ON public."observations"
  USING (((SELECT public.is_grand_master()) OR COALESCE((client_org_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "observations_insert" ON public."observations"
  WITH CHECK (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "observations_select" ON public."observations"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "observations_task_entitlement_select" ON public."observations"
  USING (
CASE
    WHEN (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)) OR ((SELECT public.is_grand_master()) OR COALESCE((client_org_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)) OR (( SELECT auth.uid() AS uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid)) THEN true
    ELSE user_has_task_entitlement(auth.uid(), id)
END);

ALTER POLICY "ocr_org_select" ON public."officer_command_requests"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "odt_select" ON public."officer_device_tokens"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "org_access_officer_field_reports" ON public."officer_field_reports"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "officer_gps_log_insert" ON public."officer_gps_log"
  WITH CHECK (((officer_id = auth.uid()) AND ((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)) AND (EXISTS ( SELECT 1
   FROM user_profiles
  WHERE ((user_profiles.id = auth.uid()) AND (user_profiles.deactivated_at IS NULL) AND (user_profiles.role = ANY (ARRAY['officer'::text, 'scan_operator'::text])))))));

ALTER POLICY "officer_gps_log_select" ON public."officer_gps_log"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "ows_select" ON public."officer_welfare_settings"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "on_call_periods_select" ON public."on_call_periods"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "onboarding_invites_select" ON public."onboarding_invites"
  USING ((is_grand_master() OR ((SELECT public.is_grand_master()) OR COALESCE((target_organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)) OR (EXISTS ( SELECT 1
   FROM user_profiles inviter_profile
  WHERE ((inviter_profile.id = onboarding_invites.invited_by) AND ((SELECT public.is_grand_master()) OR COALESCE((inviter_profile.organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)))))));

ALTER POLICY "org_corporate_officers_select" ON public."org_corporate_officers"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "ogc_select" ON public."org_geofence_config"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "org_printer_settings_select" ON public."org_printer_settings"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "organization_brand_assets_select" ON public."organization_brand_assets"
  USING ((((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)) AND ((status = 'approved'::text) OR is_admin_for_org(organization_id) OR is_grand_master())));

ALTER POLICY "organization_calendar_settings_select" ON public."organization_calendar_settings"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "organization_compliance_records_select" ON public."organization_compliance_records"
  USING ((((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)) AND (EXISTS ( SELECT 1
   FROM user_profiles actor
  WHERE ((actor.id = ( SELECT auth.uid() AS uid)) AND (actor.deactivated_at IS NULL) AND (actor.role = ANY (ARRAY['grand_master'::text, 'master'::text])))))));

ALTER POLICY "organization_fatigue_rules_select" ON public."organization_fatigue_rules"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "organization_modules_select" ON public."organization_modules"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "organization_workplaces_select" ON public."organization_workplaces"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "organizations_select" ON public."organizations"
  USING (((SELECT public.is_grand_master()) OR COALESCE((id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "pcr_insert" ON public."parking_chalk_records"
  WITH CHECK (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "pcr_select" ON public."parking_chalk_records"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "pcr_update" ON public."parking_chalk_records"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)))
  WITH CHECK (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "pin_select" ON public."parking_infringement_notices"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "pmc_insert" ON public."parking_module_config"
  WITH CHECK (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "pmc_select" ON public."parking_module_config"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "pmc_update" ON public."parking_module_config"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "parking_rule_matrix_select" ON public."parking_rule_matrix"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "parking_sessions_select" ON public."parking_sessions"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "patrol_checkpoint_visits_insert" ON public."patrol_checkpoint_visits"
  WITH CHECK (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "patrol_checkpoint_visits_select" ON public."patrol_checkpoint_visits"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "patrol_checkpoints_select" ON public."patrol_checkpoints"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "patrol_route_checkpoints_select" ON public."patrol_route_checkpoints"
  USING ((EXISTS ( SELECT 1
   FROM patrol_routes r
  WHERE ((r.id = patrol_route_checkpoints.patrol_route_id) AND ((SELECT public.is_grand_master()) OR COALESCE((r.organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false))))));

ALTER POLICY "patrol_route_sites_select" ON public."patrol_route_sites"
  USING ((EXISTS ( SELECT 1
   FROM patrol_routes r
  WHERE ((r.id = patrol_route_sites.patrol_route_id) AND ((SELECT public.is_grand_master()) OR COALESCE((r.organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false))))));

ALTER POLICY "prsm_select" ON public."patrol_route_stop_modules"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "patrol_route_zones_select" ON public."patrol_route_zones"
  USING ((EXISTS ( SELECT 1
   FROM patrol_routes r
  WHERE ((r.id = patrol_route_zones.patrol_route_id) AND ((SELECT public.is_grand_master()) OR COALESCE((r.organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false))))));

ALTER POLICY "patrol_routes_select" ON public."patrol_routes"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "psc_insert" ON public."patrol_solve_cache"
  WITH CHECK (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "psc_select" ON public."patrol_solve_cache"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "psc_update" ON public."patrol_solve_cache"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)))
  WITH CHECK (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "patrol_stop_charge_lines_finance_read" ON public."patrol_stop_charge_lines"
  USING ((((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)) AND is_admin_for_org(organization_id)));

ALTER POLICY "patrols_insert" ON public."patrols"
  WITH CHECK (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "patrols_select" ON public."patrols"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "patrols_update" ON public."patrols"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)))
  WITH CHECK (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "payment_receipts_select" ON public."payment_receipts"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "person_interactions_select" ON public."person_interactions"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "person_permit_vehicles_select" ON public."person_permit_vehicles"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "person_record_aliases_select" ON public."person_record_aliases"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "person_vehicle_links_select" ON public."person_vehicle_links"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "provider_client_access_grants_select" ON public."provider_client_access_grants"
  USING ((((SELECT public.is_grand_master()) OR COALESCE((provider_organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)) OR ((SELECT public.is_grand_master()) OR COALESCE((client_organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false))));

ALTER POLICY "ptt_channels_select" ON public."ptt_channels"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "ptt_transmissions_insert" ON public."ptt_transmissions"
  WITH CHECK (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "ptt_transmissions_select" ON public."ptt_transmissions"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "ptt_transmissions_update" ON public."ptt_transmissions"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)))
  WITH CHECK (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "quote_commercial_snapshots_select" ON public."quote_commercial_snapshots"
  USING ((((SELECT public.is_grand_master()) OR COALESCE((provider_organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)) OR ((SELECT public.is_grand_master()) OR COALESCE((client_organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false))));

ALTER POLICY "quote_lines_select" ON public."quote_lines"
  USING ((EXISTS ( SELECT 1
   FROM quotes q
  WHERE ((q.id = quote_lines.quote_id) AND (is_grand_master() OR ((SELECT public.is_grand_master()) OR COALESCE((q.provider_org_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)))))));

ALTER POLICY "quote_proposal_scope_schedules_select" ON public."quote_proposal_scope_schedules"
  USING ((EXISTS ( SELECT 1
   FROM (quote_proposal_service_scopes scope
     JOIN quotes quote ON ((quote.id = scope.quote_id)))
  WHERE ((scope.id = quote_proposal_scope_schedules.proposal_scope_id) AND ((SELECT public.is_grand_master()) OR COALESCE((quote.provider_org_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false))))));

ALTER POLICY "quote_proposal_service_scopes_select" ON public."quote_proposal_service_scopes"
  USING ((EXISTS ( SELECT 1
   FROM quotes quote
  WHERE ((quote.id = quote_proposal_service_scopes.quote_id) AND ((SELECT public.is_grand_master()) OR COALESCE((quote.provider_org_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false))))));

ALTER POLICY "quotes_select" ON public."quotes"
  USING ((is_grand_master() OR ((SELECT public.is_grand_master()) OR COALESCE((provider_org_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false))));

ALTER POLICY "radio_transcript_segments_select" ON public."radio_transcript_segments"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "radio_translation_segments_select" ON public."radio_translation_segments"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "radio_voice_consents_select" ON public."radio_voice_consents"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "reference_catalog_select" ON public."reference_catalog_entries"
  USING (((is_global_reference AND (approval_status = 'approved'::text)) OR ((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false))));

ALTER POLICY "report_templates_select" ON public."report_templates"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "retention_policies_select" ON public."retention_policies"
  USING (((organization_id IS NULL) OR ((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false))));

ALTER POLICY "roster_assignments_select" ON public."roster_assignments"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "roster_assignments_update" ON public."roster_assignments"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)))
  WITH CHECK (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "roster_skill_catalog_select" ON public."roster_skill_catalog"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "roster_templates_select" ON public."roster_templates"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "roster_work_units_select" ON public."roster_work_units"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "scv_import_batches_select" ON public."scv_import_batches"
  USING (((organization_id IS NULL) OR ((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false))));

ALTER POLICY "scv_import_rows_select" ON public."scv_import_rows"
  USING ((EXISTS ( SELECT 1
   FROM scv_import_batches b
  WHERE ((b.id = scv_import_rows.batch_id) AND ((b.organization_id IS NULL) OR ((SELECT public.is_grand_master()) OR COALESCE((b.organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)))))));

ALTER POLICY "service_agreement_delivery_schedules_select" ON public."service_agreement_delivery_schedules"
  USING ((EXISTS ( SELECT 1
   FROM service_agreements agreement
  WHERE ((agreement.id = service_agreement_delivery_schedules.service_agreement_id) AND ((SELECT public.is_grand_master()) OR COALESCE((agreement.provider_organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false))))));

ALTER POLICY "sal_select" ON public."service_agreement_locations"
  USING ((is_grand_master() OR (EXISTS ( SELECT 1
   FROM service_agreements sa
  WHERE ((sa.id = service_agreement_locations.service_agreement_id) AND (((SELECT public.is_grand_master()) OR COALESCE((sa.provider_organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)) OR ((SELECT public.is_grand_master()) OR COALESCE((sa.client_organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false))))))));

ALTER POLICY "sal_write" ON public."service_agreement_locations"
  USING ((is_grand_master() OR (EXISTS ( SELECT 1
   FROM service_agreements sa
  WHERE ((sa.id = service_agreement_locations.service_agreement_id) AND ((SELECT public.is_grand_master()) OR COALESCE((sa.provider_organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)) AND (( SELECT user_profiles.role
           FROM user_profiles
          WHERE (user_profiles.id = auth.uid())) = ANY (ARRAY['grand_master'::text, 'master'::text, 'admin'::text, 'admin_officer'::text])))))))
  WITH CHECK ((is_grand_master() OR (EXISTS ( SELECT 1
   FROM service_agreements sa
  WHERE ((sa.id = service_agreement_locations.service_agreement_id) AND ((SELECT public.is_grand_master()) OR COALESCE((sa.provider_organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)) AND (( SELECT user_profiles.role
           FROM user_profiles
          WHERE (user_profiles.id = auth.uid())) = ANY (ARRAY['grand_master'::text, 'master'::text, 'admin'::text, 'admin_officer'::text])))))));

ALTER POLICY "service_agreement_modules_select" ON public."service_agreement_modules"
  USING ((EXISTS ( SELECT 1
   FROM service_agreements s
  WHERE ((s.id = service_agreement_modules.service_agreement_id) AND (((SELECT public.is_grand_master()) OR COALESCE((s.provider_organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)) OR ((SELECT public.is_grand_master()) OR COALESCE((s.client_organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)))))));

ALTER POLICY "service_agreements_select" ON public."service_agreements"
  USING ((((SELECT public.is_grand_master()) OR COALESCE((provider_organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)) OR ((SELECT public.is_grand_master()) OR COALESCE((client_organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false))));

ALTER POLICY "shift_assets_select" ON public."shift_assets"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "shift_coverage_select" ON public."shift_coverage_requests"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "shift_stop_actions_insert" ON public."shift_stop_actions"
  WITH CHECK (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "shift_stop_actions_select" ON public."shift_stop_actions"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "ssm_insert" ON public."shift_stop_modules"
  WITH CHECK (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "ssm_select" ON public."shift_stop_modules"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "ssm_update" ON public."shift_stop_modules"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)))
  WITH CHECK (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "shift_stops_select" ON public."shift_stops"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "shift_stops_update" ON public."shift_stops"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)))
  WITH CHECK (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "shift_swaps_insert" ON public."shift_swaps"
  WITH CHECK (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "shift_swaps_select" ON public."shift_swaps"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "shift_swaps_update" ON public."shift_swaps"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)))
  WITH CHECK (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "shift_templates_select" ON public."shift_templates"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "shifts_select" ON public."shifts"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "sfc_select" ON public."site_financial_config"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "site_induction_requirements_select" ON public."site_induction_requirements"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "place_services_insert" ON public."site_services"
  WITH CHECK (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "place_services_select" ON public."site_services"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "place_services_update" ON public."site_services"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)))
  WITH CHECK (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "site_services_select" ON public."site_services"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "sla_clocks_insert" ON public."sla_clocks"
  WITH CHECK (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "sla_clocks_select" ON public."sla_clocks"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "sla_clocks_update" ON public."sla_clocks"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)))
  WITH CHECK (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "sae_select" ON public."smoke_assessment_evidence"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "sa_insert" ON public."smoke_assessments"
  WITH CHECK (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "sa_select" ON public."smoke_assessments"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "sa_update" ON public."smoke_assessments"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)))
  WITH CHECK (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "smoke_assessments_select" ON public."smoke_assessments"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "staff_availability_select" ON public."staff_availability"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "staff_biometrics_select" ON public."staff_biometrics"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "staff_credentials_select" ON public."staff_credentials"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "staff_documents_select" ON public."staff_documents"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "staff_profiles_select" ON public."staff_profiles"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "staff_site_inductions_select" ON public."staff_site_inductions"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "staff_skills_select" ON public."staff_skills"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "task_assignments_insert" ON public."task_assignments"
  WITH CHECK ((((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)) AND ((user_id = auth.uid()) OR is_admin_for_org(organization_id))));

ALTER POLICY "task_assignments_select" ON public."task_assignments"
  USING ((((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)) OR (user_id = auth.uid())));

ALTER POLICY "team_members_select" ON public."team_members"
  USING (((user_id = auth.uid()) OR (team_id IN ( SELECT teams.id
   FROM teams
  WHERE (teams.team_lead_user_id = auth.uid()))) OR (team_id IN ( SELECT teams.id
   FROM teams
  WHERE ((SELECT public.is_grand_master()) OR COALESCE((teams.organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false))))));

ALTER POLICY "teams_select" ON public."teams"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "tender_documents_select" ON public."tender_documents"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "tenders_select" ON public."tenders"
  USING ((((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)) AND (EXISTS ( SELECT 1
   FROM user_profiles up
  WHERE ((up.id = auth.uid()) AND (up.role = ANY (ARRAY['grand_master'::text, 'master'::text])))))));

ALTER POLICY "twe_select" ON public."timesheet_work_entries"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "travel_allowances_select" ON public."travel_allowances"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "user_profiles_select" ON public."user_profiles"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "vehicle_observations_insert" ON public."vehicle_observations"
  WITH CHECK (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "vehicle_observations_select" ON public."vehicle_observations"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "vehicle_observations_update" ON public."vehicle_observations"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)))
  WITH CHECK (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "vehicle_overnight_sessions_client_org_select" ON public."vehicle_overnight_sessions"
  USING (((SELECT public.is_grand_master()) OR COALESCE((client_org_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "vehicle_overnight_sessions_insert" ON public."vehicle_overnight_sessions"
  WITH CHECK (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "vehicle_overnight_sessions_select" ON public."vehicle_overnight_sessions"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "vehicle_overnight_sessions_update" ON public."vehicle_overnight_sessions"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)))
  WITH CHECK (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "vehicle_profile_photos_select" ON public."vehicle_profile_photos"
  USING ((((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)) OR (EXISTS ( SELECT 1
   FROM observations o
  WHERE (o.canonical_vehicle_id = vehicle_profile_photos.canonical_vehicle_id)))));

ALTER POLICY "vehicles_insert" ON public."vehicles"
  WITH CHECK (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "vehicles_select" ON public."vehicles"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "vehicles_update" ON public."vehicles"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)))
  WITH CHECK (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "welfare_alerts_select" ON public."welfare_alerts"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "welfare_checks_select" ON public."welfare_checks"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "workshop_bom_template_lines_select" ON public."workshop_bom_template_lines"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "workshop_bom_templates_select" ON public."workshop_bom_templates"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "workshop_work_order_lines_select" ON public."workshop_work_order_lines"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "workshop_work_orders_select" ON public."workshop_work_orders"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "zone_closures_select" ON public."zone_closures"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "zone_compliance_matrix_select" ON public."zone_compliance_matrix"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "zone_legal_config_select" ON public."zone_legal_config"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "zone_signage_evidence_insert" ON public."zone_signage_evidence"
  WITH CHECK (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));

ALTER POLICY "zone_signage_evidence_select" ON public."zone_signage_evidence"
  USING (((SELECT public.is_grand_master()) OR COALESCE((organization_id) = ANY ((SELECT public.accessible_org_ids())::uuid[]), false)));
