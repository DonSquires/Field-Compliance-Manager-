create or replace function public.notify_dispatch_job_created() returns trigger language plpgsql security definer set search_path=public as $$
declare v_officer uuid;
begin
  if new.status not in('pending','dispatched') then return new;end if;
  if new.dispatch_resource_id is not null then select dr.assigned_officer_id into v_officer from public.dispatch_resources dr where dr.id=new.dispatch_resource_id;end if;
  if v_officer is null and new.shift_id is not null then select s.officer_user_id into v_officer from public.shifts s where s.id=new.shift_id;end if;
  if v_officer is null then return new;end if;
  perform public.enqueue_notification(p_organization_id=>new.organization_id,p_category=>'dispatch',p_title=>'New dispatch assignment',p_body=>replace(new.job_type,'_',' ')||' requires your response.',p_severity=>case when new.priority in('urgent','high') then 'warning' else 'info' end,p_recipient_user_id=>v_officer,p_link_page=>'dispatch',p_link_payload=>jsonb_build_object('dispatch_job_id',new.id),p_dedup_key=>'dispatch_job_assigned:'||new.id::text);
  return new;
end;$$;
revoke all on function public.notify_dispatch_job_created() from public,anon;