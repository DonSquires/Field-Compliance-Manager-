-- Officer records reach the monthly report ledger.
--
-- Root cause: monthly packs read location_events, observations, work orders and
-- incidents for the agreement's places. Nothing projected an admin-reviewed
-- officer field report or a completed dispatch callout into that ledger, and a
-- report filed from a shift often carried the shift but no place, so it could
-- never match an agreement place.
--
-- Boundaries:
--   * Only admin-reviewed reports (review_officer_field_report sets reviewed_by)
--     and completed callouts are projected. Submitted reports stay internal.
--   * Maintenance reports are in-house records and are not projected.
--   * Health and safety reports become a client site hazard check (owner ruling
--     2026-11-06), incident reports become other site work that the existing
--     incident triage step can confirm.
--   * Officer names, persons involved, GPS, report titles, briefing notes and
--     photos never enter the payload. Free text passes through the existing
--     report redaction and the Privacy Oracle gate before any client delivery.
--     Officer photos stay in their private, pending-review lane.
--   * Staff-sensitive investigations are never projected.
--   * Projection is idempotent on (organization_id, event_type, external_ref).
begin;

create or replace function public.officer_report_inherit_shift_place()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_count integer;
  v_site uuid;
  v_zone uuid;
begin
  if new.shift_id is null or new.site_id is not null or new.zone_id is not null then
    return new;
  end if;
  select count(*), (array_agg(p.site_id))[1], (array_agg(p.zone_id))[1]
    into v_count, v_site, v_zone
  from (
    select distinct st.site_id, st.zone_id
    from public.shift_stops st
    join public.shifts s on s.id = st.shift_id and s.organization_id = new.organization_id
    where st.shift_id = new.shift_id
      and (st.site_id is not null or st.zone_id is not null)
  ) p;
  if coalesce(v_count, 0) = 0 then
    -- A static shift may carry its place on the shift rather than on stops.
    select count(*), (array_agg(p.site_id))[1], (array_agg(p.zone_id))[1]
      into v_count, v_site, v_zone
    from (
      select l.site_id, l.zone_id
      from public.shifts s
      join public.service_agreement_locations l on l.id = s.service_agreement_location_id
      where s.id = new.shift_id and s.organization_id = new.organization_id
        and (l.site_id is not null or l.zone_id is not null)
      union
      select null::uuid, s.zone_id
      from public.shifts s
      where s.id = new.shift_id and s.organization_id = new.organization_id
        and s.service_agreement_location_id is null and s.zone_id is not null
    ) p;
  end if;
  -- Only an unambiguous single place is inherited; a multi-place patrol shift
  -- leaves the report unplaced for an admin to resolve.
  if v_count = 1 then
    if v_zone is not null then
      new.zone_id := v_zone;
    else
      new.site_id := v_site;
    end if;
  end if;
  return new;
end;
$function$;
revoke all on function public.officer_report_inherit_shift_place() from public, anon, authenticated, service_role;

-- Sorts before trg_officer_field_reports_resolve_canonical_identity so the
-- inherited place is resolved to its canonical identity in the same write.
drop trigger if exists trg_officer_field_reports_inherit_shift_place on public.officer_field_reports;
create trigger trg_officer_field_reports_inherit_shift_place
  before insert or update of shift_id on public.officer_field_reports
  for each row execute function public.officer_report_inherit_shift_place();

create or replace function public.project_officer_field_report_to_ledger(p_report_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  r public.officer_field_reports%rowtype;
  v_id uuid;
  v_issue text;
  v_activity text;
begin
  select * into r from public.officer_field_reports where id = p_report_id;
  if not found
    or r.status not in ('reviewed', 'closed')
    or r.reviewed_by is null or r.reviewed_at is null
    or r.report_type = 'maintenance'
    or (r.site_id is null and r.zone_id is null) then
    return null;
  end if;
  if r.investigation_id is not null and exists (
    select 1 from public.incidents i
    where i.investigation_id = r.investigation_id and i.is_staff_sensitive
  ) then
    return null;
  end if;
  -- The same offline submission replayed by another device is one record.
  if r.client_event_id is not null and exists (
    select 1 from public.location_events e
    where e.organization_id = r.organization_id
      and e.event_type = 'officer_field_report'
      and e.external_ref <> r.id::text
      and e.payload ->> 'client_event_id' = r.client_event_id::text
  ) then
    return null;
  end if;

  if r.report_type = 'health_safety' then
    v_issue := 'Site hazard check';
    v_activity := 'inspection';
  else
    v_issue := 'Officer incident report';
    v_activity := 'other';
  end if;

  insert into public.location_events (
    organization_id, client_site_id, zone_id, event_type, occurred_at,
    status, source, external_ref, payload, created_by
  ) values (
    r.organization_id,
    case when r.zone_id is null then r.site_id end,
    r.zone_id,
    'officer_field_report',
    r.reported_at,
    r.status::text,
    'officer_field_report',
    r.id::text,
    jsonb_strip_nulls(jsonb_build_object(
      'officer_field_report_id', r.id,
      'client_event_id', r.client_event_id,
      'report_type', r.report_type::text,
      'severity', r.severity::text,
      'client_visibility', case when r.report_type = 'health_safety' then 'client_site_hazard' end,
      'work_activity_code', v_activity,
      'issue', v_issue,
      'comments', nullif(btrim(r.description), ''),
      'action_notes', nullif(btrim(coalesce(r.immediate_action, '')), '')
    )),
    r.reviewed_by
  )
  on conflict (organization_id, event_type, external_ref) where external_ref is not null do nothing
  returning id into v_id;
  return v_id;
end;
$function$;
revoke all on function public.project_officer_field_report_to_ledger(uuid) from public, anon, authenticated, service_role;

create or replace function public.project_dispatch_job_to_ledger(p_job_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  j public.dispatch_jobs%rowtype;
  v_id uuid;
begin
  select * into j from public.dispatch_jobs where id = p_job_id;
  if not found or j.status <> 'completed'
    or (j.client_site_id is null and j.zone_id is null) then
    return null;
  end if;
  if j.investigation_id is not null and exists (
    select 1 from public.incidents i
    where i.investigation_id = j.investigation_id and i.is_staff_sensitive
  ) then
    return null;
  end if;
  -- An incident raised from the callout already reports it.
  if exists (select 1 from public.incidents i where i.dispatch_job_id = j.id) then
    return null;
  end if;

  -- briefing_notes can carry complainant details and are never copied.
  insert into public.location_events (
    organization_id, client_site_id, zone_id, event_type, module_key, occurred_at,
    status, source, external_ref, payload
  ) values (
    j.organization_id,
    case when j.zone_id is null then j.client_site_id end,
    j.zone_id,
    'dispatch_callout',
    j.module_key,
    coalesce(j.completed_at, j.on_scene_at, now()),
    'completed',
    'dispatch_job',
    j.id::text,
    jsonb_strip_nulls(jsonb_build_object(
      'dispatch_job_id', j.id,
      'job_type', case when j.job_type ~ '^[a-z0-9_]{1,40}$' then j.job_type end,
      'priority', case when j.priority ~ '^[a-z0-9_]{1,20}$' then j.priority end,
      'work_activity_code', 'other',
      'issue', 'Callout attendance',
      'comments', nullif(btrim(coalesce(j.outcome_notes, '')), '')
    ))
  )
  on conflict (organization_id, event_type, external_ref) where external_ref is not null do nothing
  returning id into v_id;
  return v_id;
end;
$function$;
revoke all on function public.project_dispatch_job_to_ledger(uuid) from public, anon, authenticated, service_role;

create or replace function public.tg_project_officer_field_report_to_ledger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform public.project_officer_field_report_to_ledger(new.id);
  return null;
end;
$function$;
revoke all on function public.tg_project_officer_field_report_to_ledger() from public, anon, authenticated, service_role;

drop trigger if exists trg_officer_field_reports_project_to_ledger on public.officer_field_reports;
create trigger trg_officer_field_reports_project_to_ledger
  after insert or update on public.officer_field_reports
  for each row
  when (new.status in ('reviewed', 'closed') and new.reviewed_by is not null)
  execute function public.tg_project_officer_field_report_to_ledger();

create or replace function public.tg_project_dispatch_job_to_ledger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform public.project_dispatch_job_to_ledger(new.id);
  return null;
end;
$function$;
revoke all on function public.tg_project_dispatch_job_to_ledger() from public, anon, authenticated, service_role;

drop trigger if exists trg_dispatch_jobs_project_to_ledger on public.dispatch_jobs;
create trigger trg_dispatch_jobs_project_to_ledger
  after insert or update of status, completed_at, client_site_id, zone_id on public.dispatch_jobs
  for each row
  when (new.status = 'completed')
  execute function public.tg_project_dispatch_job_to_ledger();

-- Backfill: place reports already filed from a single-place shift, then
-- project records that were already reviewed or completed.
update public.officer_field_reports
set shift_id = shift_id
where shift_id is not null and site_id is null and zone_id is null;

select public.project_officer_field_report_to_ledger(r.id)
from public.officer_field_reports r
where r.status in ('reviewed', 'closed') and r.reviewed_by is not null
order by r.reported_at, r.id;

select public.project_dispatch_job_to_ledger(j.id)
from public.dispatch_jobs j
where j.status = 'completed'
order by j.completed_at, j.id;

comment on function public.project_officer_field_report_to_ledger(uuid) is
  'Internal: projects one admin-reviewed incident or health and safety officer report into location_events for agreement reports. No names, persons, GPS, titles or photos. Idempotent.';
comment on function public.project_dispatch_job_to_ledger(uuid) is
  'Internal: projects one completed dispatch callout into location_events as Callout attendance with outcome notes only (never briefing notes). Idempotent.';

commit;
