-- The next actor sees it: when the client's administrator sets their password and accepts, the person who sent the
-- invitation (and the administrators of the organisation holding the agreement) get an in-app notification that opens
-- the Client Portfolio. Before this the provider only found out by re-opening the panel.
-- 'crm_client' joins the notification vocabulary: client relationship events for the provider (invitation accepted, ...).
alter table public.notifications drop constraint if exists notifications_category_check;
alter table public.notifications add constraint notifications_category_check check (category = any (array[
  'credential_expiry', 'sla_breach', 'report_ready', 'report_reviewed', 'leave_decision', 'timesheet_decision', 'breach_decision',
  'debrief_followup', 'noise_review', 'biosecurity_review', 'document_review', 'welfare', 'dispatch', 'roster', 'open_job',
  'video_review', 'system', 'schema_change_request', 'bob_conversation', 'bob_self_memory', 'crm_client']));

create or replace function public.accept_client_invitation()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_actor uuid := auth.uid();
  v_profile public.user_profiles%rowtype;
  v_client_name text;
  v_accepted integer := 0;
  v_row record;
  v_inviter uuid;
begin
  select * into v_profile from public.user_profiles where id = v_actor and deactivated_at is null;
  if not found then raise exception 'Active user required'; end if;
  select name into v_client_name from public.organizations where id = v_profile.organization_id;

  for v_row in
    update public.service_agreements a
    set invitation_status = 'accepted'
    where a.client_organization_id = v_profile.organization_id
      and a.invitation_status = 'invited'
    returning a.id, a.name, a.agreement_type, a.provider_organization_id
  loop
    v_accepted := v_accepted + 1;
    insert into public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
    values (v_row.provider_organization_id, v_actor, 'client_invitation_accepted', 'service_agreements', v_row.id,
      jsonb_build_object('client_organization_id', v_profile.organization_id, 'agreement_name', v_row.name, 'agreement_type', v_row.agreement_type, 'accepted_by_role', v_profile.role));

    -- whoever prepared the invitation hears first, by name; the agreement holder's administrators as a role
    select l.actor_user_id into v_inviter
    from public.audit_log l
    where l.action = 'crm_client_invitation_prepared' and l.target_id = v_row.id
    order by l.created_at desc limit 1;
    if v_inviter is not null then
      perform public.enqueue_notification(
        p_organization_id => v_row.provider_organization_id, p_category => 'crm_client',
        p_title => coalesce(v_client_name, 'The client') || ' has accepted your invitation',
        p_body => coalesce(v_profile.display_name, 'Their administrator') || ' set their password and can sign in to the client portal. Finish the provider setup, then activate the account.',
        p_severity => 'info', p_recipient_user_id => v_inviter, p_recipient_role => null, p_link_page => 'crm',
        p_link_payload => jsonb_build_object('account_organization_id', v_profile.organization_id, 'agreement_id', v_row.id),
        p_dedup_key => 'crm_client_accepted:' || v_row.id::text || ':' || v_inviter::text);
    end if;
    -- the inviter already has their own row; an admin inviter would otherwise read the same news twice
    if v_inviter is null or not exists (select 1 from public.user_profiles p where p.id = v_inviter and p.role = 'admin') then
    perform public.enqueue_notification(
      p_organization_id => v_row.provider_organization_id, p_category => 'crm_client',
      p_title => coalesce(v_client_name, 'A client') || ' has accepted the invitation',
      p_body => coalesce(v_profile.display_name, 'Their administrator') || ' can now sign in to the client portal.',
      p_severity => 'info', p_recipient_user_id => null, p_recipient_role => 'admin', p_link_page => 'crm',
      p_link_payload => jsonb_build_object('account_organization_id', v_profile.organization_id, 'agreement_id', v_row.id),
      p_dedup_key => 'crm_client_accepted:' || v_row.id::text || ':admin');
    end if;
  end loop;
  return jsonb_build_object('accepted', v_accepted, 'organization_id', v_profile.organization_id);
end;
$$;
