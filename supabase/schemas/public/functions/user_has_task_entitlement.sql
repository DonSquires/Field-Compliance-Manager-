create or replace function public.user_has_task_entitlement (
  p_user                      uuid default auth.uid(),
  p_observation_id            uuid default null::uuid,
  p_noise_assessment_id       uuid default null::uuid,
  p_smoke_assessment_id       uuid default null::uuid,
  p_biosecurity_assessment_id uuid default null::uuid,
  p_incident_id               uuid default null::uuid,
  p_notice_id                 uuid default null::uuid,
  p_enforcement_case_id       uuid default null::uuid
)
  returns boolean
  language sql
  stable
  security definer
  set search_path to 'public'
  AS $function$
  select coalesce(
    (public.resolve_access_basis(
        p_user, p_observation_id, p_noise_assessment_id, p_smoke_assessment_id,
        p_biosecurity_assessment_id, p_incident_id, p_notice_id, p_enforcement_case_id
     ) ->> 'decision_state') not in ('no_task_entitlement', 'hard_stop'),
    false
  );
$function$;

grant execute on function "public"."user_has_task_entitlement"(uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid) to public, "anon", "authenticated", "postgres", "service_role";

comment on function "public"."user_has_task_entitlement"(uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid) is 'STRICT BOOLEAN for RLS (ACCESS_MODEL.md section 8). Derived from resolve_access_basis so boolean and UI object can never disagree. SECURITY DEFINER + fixed search_path (0326). 0329: p_user defaults to auth.uid(); the self-only guard lives in resolve_access_basis. On the 0325 observations RLS path the policy passes the authenticated reader (p_user = auth.uid()), so the boolean behaviour is unchanged.';
