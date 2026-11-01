-- These SECURITY DEFINER helpers are policy predicates, not anonymous RPCs.
-- Keep authenticated access for RLS and preserve the existing service_role grants.
REVOKE EXECUTE ON FUNCTION public.current_user_role() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.is_master_or_above() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.user_managed_branch_ids() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.wf_has_role(public.wf_app_role) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.user_has_task_entitlement(uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.is_platform_owner(uuid) FROM PUBLIC, anon;

-- These predicates are account-scoped; anonymous requests must not evaluate them.
ALTER POLICY "access_presets_write" ON public.access_presets TO authenticated;
ALTER POLICY "bob_self_memory_delete" ON public.bob_self_memory TO authenticated;
ALTER POLICY "bob_self_memory_select" ON public.bob_self_memory TO authenticated;
ALTER POLICY "notifications_select" ON public.notifications TO authenticated;
ALTER POLICY "notifications_update" ON public.notifications TO authenticated;
ALTER POLICY "preset_assignments_select" ON public.preset_assignments TO authenticated;
ALTER POLICY "staff_reporting_select" ON public.staff_reporting TO authenticated;
ALTER POLICY "staff_reporting_write" ON public.staff_reporting TO authenticated;
ALTER POLICY "team_members_write" ON public.team_members TO authenticated;
ALTER POLICY "teams_write" ON public.teams TO authenticated;