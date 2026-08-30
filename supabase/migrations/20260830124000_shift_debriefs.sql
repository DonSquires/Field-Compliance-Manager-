create table public.shift_debriefs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  shift_id uuid not null references public.shifts(id) on delete restrict,
  officer_user_id uuid not null references public.user_profiles(id) on delete restrict,
  client_event_id uuid not null,
  summary text not null,
  safety_incident_reported boolean not null default false,
  equipment_issue_reported boolean not null default false,
  follow_up_required boolean not null default false,
  follow_up_notes text,
  submitted_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (shift_id),
  unique (organization_id, officer_user_id, client_event_id),
  constraint shift_debriefs_summary_length_check check (char_length(trim(summary)) between 10 and 5000),
  constraint shift_debriefs_follow_up_check check (not follow_up_required or nullif(trim(follow_up_notes), '') is not null)
);

comment on table public.shift_debriefs is 'Append-only officer handover submitted after operational work. Shift completion remains a separate lifecycle truth.';

create index idx_shift_debriefs_org_submitted on public.shift_debriefs (organization_id, submitted_at desc);
alter table public.shift_debriefs enable row level security;
create policy shift_debriefs_select on public.shift_debriefs for select to authenticated
  using (officer_user_id = auth.uid() or public.is_admin_for_org(organization_id));
revoke all on table public.shift_debriefs from public, anon, authenticated;
grant select on table public.shift_debriefs to authenticated;
grant all on table public.shift_debriefs to service_role;

create function public.submit_shift_debrief(
  p_shift_id uuid,
  p_client_event_id uuid,
  p_summary text,
  p_safety_incident_reported boolean default false,
  p_equipment_issue_reported boolean default false,
  p_follow_up_required boolean default false,
  p_follow_up_notes text default null
) returns table (id uuid, created boolean, submitted_at timestamptz)
language plpgsql volatile security definer set search_path = public as $$
declare
  v_user_id uuid := auth.uid();
  v_shift public.shifts%rowtype;
  v_debrief public.shift_debriefs%rowtype;
begin
  if v_user_id is null then raise exception 'Authentication required'; end if;
  if p_client_event_id is null then raise exception 'client_event_id is required'; end if;
  if char_length(trim(coalesce(p_summary, ''))) not between 10 and 5000 then raise exception 'Debrief summary must be between 10 and 5000 characters'; end if;
  if p_follow_up_required and nullif(trim(coalesce(p_follow_up_notes, '')), '') is null then raise exception 'Follow-up notes are required'; end if;
  select s.* into v_shift from public.shifts s where s.id = p_shift_id for share;
  if not found then raise exception 'Shift not found'; end if;
  if v_shift.officer_user_id <> v_user_id then raise exception 'Shift does not belong to the authenticated officer'; end if;
  if v_shift.status not in ('accepted', 'in_progress', 'completed') then raise exception 'Shift is not eligible for debrief'; end if;
  select d.* into v_debrief from public.shift_debriefs d
  where d.organization_id = v_shift.organization_id and d.officer_user_id = v_user_id and d.client_event_id = p_client_event_id;
  if found then return query select v_debrief.id, false, v_debrief.submitted_at; return; end if;
  if exists (select 1 from public.shift_debriefs d where d.shift_id = p_shift_id) then raise exception 'A debrief has already been submitted for this shift'; end if;
  insert into public.shift_debriefs (organization_id, shift_id, officer_user_id, client_event_id, summary, safety_incident_reported, equipment_issue_reported, follow_up_required, follow_up_notes)
  values (v_shift.organization_id, p_shift_id, v_user_id, p_client_event_id, trim(p_summary), coalesce(p_safety_incident_reported, false), coalesce(p_equipment_issue_reported, false), coalesce(p_follow_up_required, false), nullif(trim(coalesce(p_follow_up_notes, '')), ''))
  returning * into v_debrief;
  insert into public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (v_shift.organization_id, v_user_id, 'shift_debrief_submitted', 'shift_debriefs', v_debrief.id,
    jsonb_build_object('shift_id', p_shift_id, 'safety_incident_reported', v_debrief.safety_incident_reported, 'equipment_issue_reported', v_debrief.equipment_issue_reported, 'follow_up_required', v_debrief.follow_up_required));
  return query select v_debrief.id, true, v_debrief.submitted_at;
end;
$$;

comment on function public.submit_shift_debrief(uuid, uuid, text, boolean, boolean, boolean, text) is 'Creates one retry-safe, self-owned, append-only handover per eligible shift and audits submission.';
revoke all on function public.submit_shift_debrief(uuid, uuid, text, boolean, boolean, boolean, text) from public, anon;
grant execute on function public.submit_shift_debrief(uuid, uuid, text, boolean, boolean, boolean, text) to authenticated, service_role;