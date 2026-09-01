alter table public.noise_assessments add column if not exists review_status text not null default 'open',add column if not exists reviewed_by uuid references public.user_profiles(id) on delete set null,add column if not exists reviewed_at timestamptz,add column if not exists review_notes text;
alter table public.noise_assessments drop constraint if exists noise_assessments_review_status_check;
alter table public.noise_assessments add constraint noise_assessments_review_status_check check(review_status in('open','acknowledged','follow_up','closed'));
revoke update,delete on table public.noise_assessments from authenticated;

create function public.manage_noise_assessment_review(p_assessment_id uuid,p_expected_review_status text,p_action text,p_notes text)
returns table(assessment_id uuid,review_status text,reviewed_by uuid,reviewed_at timestamptz,follow_up_required boolean) language plpgsql security definer set search_path=public as $$
declare v_actor uuid:=auth.uid();v_item public.noise_assessments%rowtype;v_officer uuid;v_next text;v_notes text:=nullif(trim(coalesce(p_notes,'')),'');
begin
  select n.* into v_item from public.noise_assessments n where n.id=p_assessment_id for update;if not found then raise exception 'Noise assessment not found';end if;
  if not public.is_admin_for_org(v_item.organization_id) then raise exception 'Active Noise Control administrator required';end if;
  if v_item.review_status<>p_expected_review_status then raise exception 'Noise review changed from expected status % to %',p_expected_review_status,v_item.review_status;end if;
  if v_notes is null then raise exception 'Noise review notes are required';end if;
  if p_action='acknowledge' and v_item.review_status='open' then v_next:='acknowledged';
  elsif p_action='require_follow_up' and v_item.review_status in('open','acknowledged','follow_up') then v_next:='follow_up';
  elsif p_action='close' and v_item.review_status in('open','acknowledged','follow_up') then v_next:='closed';
  else raise exception 'Unsupported Noise Control review transition from % using %',v_item.review_status,p_action;end if;
  update public.noise_assessments set review_status=v_next,reviewed_by=v_actor,reviewed_at=clock_timestamp(),review_notes=v_notes,follow_up_required=case when v_next='follow_up' then true when v_next='closed' then false else follow_up_required end where id=v_item.id returning * into v_item;
  v_officer:=coalesce(v_item.officer_user_id,v_item.officer_id);
  insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata) values(v_item.organization_id,v_actor,'noise_assessment_reviewed','noise_assessments',v_item.id,jsonb_build_object('previous_review_status',p_expected_review_status,'review_status',v_item.review_status,'action',p_action,'source_officer_id',v_officer,'notes',v_notes));
  if v_officer is not null then perform public.enqueue_notification(p_organization_id=>v_item.organization_id,p_category=>'noise_review',p_title=>'Noise assessment reviewed',p_body=>v_notes,p_severity=>case when v_next='follow_up' then 'warning' else 'info' end,p_recipient_user_id=>v_officer,p_link_page=>'noise-review',p_link_payload=>jsonb_build_object('assessment_id',v_item.id),p_dedup_key=>'noise_review:'||v_item.id::text||':'||v_item.review_status);end if;
  return query select v_item.id,v_item.review_status,v_item.reviewed_by,v_item.reviewed_at,v_item.follow_up_required;
end;$$;
revoke all on function public.manage_noise_assessment_review(uuid,text,text,text) from public,anon;
grant execute on function public.manage_noise_assessment_review(uuid,text,text,text) to authenticated,service_role;

alter table public.notifications drop constraint if exists notifications_category_check;
alter table public.notifications add constraint notifications_category_check check(category in('credential_expiry','sla_breach','report_ready','report_reviewed','leave_decision','timesheet_decision','breach_decision','debrief_followup','noise_review','welfare','dispatch','roster','open_job','system','schema_change_request','bob_conversation','bob_self_memory'));
