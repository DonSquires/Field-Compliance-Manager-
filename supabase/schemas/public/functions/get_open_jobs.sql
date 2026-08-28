create or replace function public.get_open_jobs (
  p_limit  integer default 100,
  p_offset integer default 0
)
  returns table (
    source          text,
    job_id          uuid,
    organization_id uuid,
    status          text,
    priority        text,
    title           text,
    starts_at       timestamp with time zone,
    created_at      timestamp with time zone,
    payload         jsonb
  )
  language sql
  stable
  set search_path to 'public'
  AS $function$
  with jobs as (
    select
      'dispatch'::text as source,
      dj.id as job_id,
      dj.organization_id,
      dj.status::text as status,
      dj.priority::text as priority,
      coalesce(dj.job_type, 'dispatch job')::text as title,
      coalesce(dj.dispatched_at, dj.created_at) as starts_at,
      dj.created_at,
      jsonb_build_object(
        'client_site_id', dj.client_site_id,
        'shift_id', dj.shift_id,
        'dispatch_resource_id', dj.dispatch_resource_id,
        'sla_respond_by', dj.sla_respond_by
      ) as payload
    from public.dispatch_jobs dj
    where dj.status in ('pending', 'dispatched', 'en_route', 'on_scene')
      and public.org_access_allowed(dj.organization_id)

    union all

    select
      'shift_coverage'::text as source,
      scr.id as job_id,
      scr.organization_id,
      scr.status::text as status,
      scr.urgency::text as priority,
      'open shift coverage'::text as title,
      (scr.shift_date::timestamp + scr.start_time) at time zone 'UTC' as starts_at,
      scr.created_at,
      jsonb_build_object(
        'site_id', scr.site_id,
        'patrol_route_id', scr.patrol_route_id,
        'required_staff_count', scr.required_staff_count,
        'required_credentials', scr.required_credentials
      ) as payload
    from public.shift_coverage_requests scr
    where scr.status = 'open'
      and public.org_access_allowed(scr.organization_id)
  )
  select
    j.source,
    j.job_id,
    j.organization_id,
    j.status,
    j.priority,
    j.title,
    j.starts_at,
    j.created_at,
    j.payload
  from jobs j
  order by j.created_at desc
  limit greatest(coalesce(p_limit, 100), 1)
  offset greatest(coalesce(p_offset, 0), 0);
$function$;

grant execute on function "public"."get_open_jobs"(integer, integer) to public, "anon", "authenticated", "postgres", "service_role";
