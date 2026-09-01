create table public.debrief_followups(
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  debrief_id uuid not null unique references public.shift_debriefs(id) on delete cascade,
  shift_id uuid not null references public.shifts(id) on delete restrict,
  officer_user_id uuid not null references public.user_profiles(id) on delete restrict,
  status text not null default 'open' check(status in('open','claimed','escalated','resolved')),
  priority text not null default 'normal' check(priority in('normal','high','critical')),
  owner_user_id uuid references public.user_profiles(id) on delete set null,
  version integer not null default 1,
  latest_note text,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index debrief_followups_org_status_idx on public.debrief_followups(organization_id,status,priority,created_at desc);
alter table public.debrief_followups enable row level security;
create policy debrief_followups_select on public.debrief_followups for select to authenticated using(public.is_admin_for_org(organization_id) or officer_user_id=auth.uid());
revoke all on table public.debrief_followups from public,anon;
revoke insert,update,delete on table public.debrief_followups from authenticated;
grant select on table public.debrief_followups to authenticated;
grant all on table public.debrief_followups to service_role;

create function public.seed_debrief_followup() returns trigger language plpgsql security definer set search_path=public as $$
begin
  if new.safety_incident_reported or new.equipment_issue_reported or new.follow_up_required then
    insert into public.debrief_followups(organization_id,debrief_id,shift_id,officer_user_id,priority,latest_note)
    values(new.organization_id,new.id,new.shift_id,new.officer_user_id,case when new.safety_incident_reported then 'critical' when new.equipment_issue_reported then 'high' else 'normal' end,new.follow_up_notes)
    on conflict(debrief_id) do nothing;
  end if;
  return new;
end;$$;
create trigger debrief_followup_after_insert after insert on public.shift_debriefs for each row execute function public.seed_debrief_followup();
revoke all on function public.seed_debrief_followup() from public,anon,authenticated;

create function public.manage_debrief_followup(p_followup_id uuid,p_expected_version integer,p_action text,p_note text)
returns table(followup_id uuid,followup_status text,owner_user_id uuid,followup_version integer,acted_at timestamptz) language plpgsql security definer set search_path=public as $$
declare v_actor uuid:=auth.uid();v_item public.debrief_followups%rowtype;v_note text:=nullif(trim(coalesce(p_note,'')),'');
begin
  select f.* into v_item from public.debrief_followups f where f.id=p_followup_id for update;if not found then raise exception 'Debrief follow-up not found';end if;
  if not public.is_admin_for_org(v_item.organization_id) then raise exception 'Active operations administrator required';end if;
  if v_item.version<>p_expected_version then raise exception 'Debrief follow-up changed since it was opened';end if;
  if v_note is null then raise exception 'Follow-up action notes are required';end if;
  if p_action='claim' and v_item.status='open' then update public.debrief_followups set status='claimed',owner_user_id=v_actor,latest_note=v_note,version=version+1,updated_at=clock_timestamp() where id=v_item.id returning * into v_item;
  elsif p_action='escalate' and v_item.status in('open','claimed') then update public.debrief_followups set status='escalated',owner_user_id=coalesce(owner_user_id,v_actor),latest_note=v_note,version=version+1,updated_at=clock_timestamp() where id=v_item.id returning * into v_item;
  elsif p_action='resolve' and v_item.status in('claimed','escalated') then update public.debrief_followups set status='resolved',owner_user_id=coalesce(owner_user_id,v_actor),latest_note=v_note,resolved_at=clock_timestamp(),version=version+1,updated_at=clock_timestamp() where id=v_item.id returning * into v_item;
  else raise exception 'Unsupported debrief follow-up transition from % using %',v_item.status,p_action;end if;
  insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata) values(v_item.organization_id,v_actor,'debrief_followup_managed','debrief_followups',v_item.id,jsonb_build_object('action',p_action,'status',v_item.status,'owner_user_id',v_item.owner_user_id,'version',v_item.version,'note',v_note));
  if p_action in('escalate','resolve') then perform public.enqueue_notification(p_organization_id=>v_item.organization_id,p_category=>'debrief_followup',p_title=>case when p_action='resolve' then 'Debrief follow-up resolved' else 'Debrief follow-up escalated' end,p_body=>v_note,p_severity=>case when p_action='escalate' then 'warning' else 'info' end,p_recipient_user_id=>v_item.officer_user_id,p_link_page=>'debrief-followup',p_link_payload=>jsonb_build_object('debrief_id',v_item.debrief_id,'followup_id',v_item.id),p_dedup_key=>'debrief_followup:'||v_item.id::text||':'||v_item.version::text);end if;
  return query select v_item.id,v_item.status,v_item.owner_user_id,v_item.version,v_item.updated_at;
end;$$;
revoke all on function public.manage_debrief_followup(uuid,integer,text,text) from public,anon;
grant execute on function public.manage_debrief_followup(uuid,integer,text,text) to authenticated,service_role;

alter table public.notifications drop constraint if exists notifications_category_check;
alter table public.notifications add constraint notifications_category_check check(category in('credential_expiry','sla_breach','report_ready','report_reviewed','leave_decision','timesheet_decision','breach_decision','debrief_followup','welfare','dispatch','roster','open_job','system','schema_change_request','bob_conversation','bob_self_memory'));
