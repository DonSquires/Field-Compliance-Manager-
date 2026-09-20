-- Client invitation loop (owner walk 2026-09-20): the provider invites a client, the client lands on 'set your
-- password', acceptance is recorded, and the provider can activate. Before this, four seams were broken:
--   1. invite-org gave every invited first user the provider role 'master' -> a client's first user was routed to the
--      provider admin shell. Clients under an operational agreement now get 'client_admin' (client portal); only a
--      platform subscriber under the owner's financial agreement (or a same-org bootstrap) gets 'master'.
--   2. invite-org authorised only 'master'/'grand_master' callers against agreements held by the caller's HOME org,
--      while prepare_crm_client_invitation let any provider admin prepare -> branch-held agreements (First Security
--      Nelson) were refused, and prepare could mint a duplicate agreement under the parent organisation.
--   3. Nothing ever marked invitation_status = 'accepted' except accept_quote, so activate_crm_account
--      ('Accepted operational agreement required') and crm_actor_can_manage_account could never be satisfied through
--      the invite path. accept_client_invitation() records the client's acceptance at first sign-in.
--   4. The first user's employer_organization_id was left null; own-rooted users have employer = organisation.


-- Who may invite the first user of p_target_organization_id, under which agreement, and with which role.
create or replace function public.resolve_org_invitation(p_target_organization_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_actor uuid := auth.uid();
  v_profile public.user_profiles%rowtype;
  v_target public.organizations%rowtype;
  v_agreement public.service_agreements%rowtype;
  v_scope uuid[];
begin
  select * into v_profile from public.user_profiles where id = v_actor and deactivated_at is null;
  if not found or v_profile.role not in ('grand_master', 'master', 'admin') then raise exception 'Not authorised to invite users for this organisation'; end if;
  select * into v_target from public.organizations where id = p_target_organization_id;
  if not found then raise exception 'Organisation not found'; end if;

  -- own organisation: a master seats the first user of their own organisation (bootstrap only; claim_first_org_user refuses a second)
  if v_target.id = v_profile.organization_id and v_profile.role in ('grand_master', 'master') then
    return jsonb_build_object('kind', 'same_org', 'role', 'master', 'agreement_id', null, 'provider_organization_id', v_target.id, 'invitation_status', null);
  end if;

  -- reach: the employing organisation and its branches, plus any branch the actor is authorised at
  v_scope := public.get_descendant_organizations(coalesce(v_profile.employer_organization_id, v_profile.organization_id))
    || coalesce((select array_agg(a.branch_org_id) from public.staff_branch_authorisations a where a.user_id = v_actor and a.status = 'active'), '{}'::uuid[]);

  -- a client of the actor's provider under an operational agreement: the client's first user runs the client portal
  select a.* into v_agreement
  from public.service_agreements a
  where a.client_organization_id = v_target.id
    and a.agreement_type = 'operational'
    and a.provider_organization_id = any(v_scope)
    and (a.ends_on is null or a.ends_on >= current_date)
    and public.is_admin_for_org(a.provider_organization_id)
  order by case a.invitation_status when 'invited' then 0 when 'not_invited' then 1 when 'accepted' then 2 else 3 end, a.created_at desc
  limit 1;
  if found then
    return jsonb_build_object('kind', 'client', 'role', 'client_admin', 'agreement_id', v_agreement.id, 'provider_organization_id', v_agreement.provider_organization_id, 'invitation_status', v_agreement.invitation_status);
  end if;

  -- a platform subscriber under the owner's financial agreement: the subscriber's first master (owner ruling 2026-09-15)
  if v_profile.role = 'grand_master' then
    select a.* into v_agreement
    from public.service_agreements a
    where a.client_organization_id = v_target.id
      and a.agreement_type = 'financial'
      and a.provider_organization_id = any(v_scope)
      and (a.ends_on is null or a.ends_on >= current_date)
    order by a.created_at desc
    limit 1;
    if found then
      return jsonb_build_object('kind', 'subscriber', 'role', 'master', 'agreement_id', v_agreement.id, 'provider_organization_id', v_agreement.provider_organization_id, 'invitation_status', v_agreement.invitation_status);
    end if;
  end if;

  raise exception 'Not authorised to invite users for this organisation';
end;
$$;
revoke all on function public.resolve_org_invitation(uuid) from public, anon;
grant execute on function public.resolve_org_invitation(uuid) to authenticated, service_role;
comment on function public.resolve_org_invitation(uuid) is 'For invite-org: which agreement authorises the caller to seat the first user of the target organisation and which role that user gets (client_admin under an operational agreement; master for a platform subscriber or own-org bootstrap). Raises when not authorised.';

-- The first user of an own-rooted organisation is employed by that organisation; only the two first-user roles are allowed.
create or replace function public.claim_first_org_user(p_org_id uuid, p_user_id uuid, p_display_name text, p_role text, p_email text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_existing_count integer;
begin
  if p_role not in ('master', 'client_admin') then raise exception 'The first user of an organisation is a master or a client administrator'; end if;
  perform pg_advisory_xact_lock(hashtext(p_org_id::text));
  select count(*) into v_existing_count from public.user_profiles where organization_id = p_org_id;
  if v_existing_count > 0 then
    raise exception 'Organisation already has users — duplicate first-user prevented' using errcode = '23505';
  end if;
  insert into public.user_profiles (id, organization_id, employer_organization_id, display_name, role, email)
  values (p_user_id, p_org_id, p_org_id, p_display_name, p_role, p_email)
  on conflict (id) do update set
    organization_id = excluded.organization_id,
    employer_organization_id = excluded.employer_organization_id,
    display_name = excluded.display_name,
    role = excluded.role,
    email = excluded.email;
end;
$$;

-- The invited user, once signed in, accepts on behalf of their organisation: every 'invited' agreement naming it as client.
create or replace function public.accept_client_invitation()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_actor uuid := auth.uid();
  v_profile public.user_profiles%rowtype;
  v_accepted integer;
begin
  select * into v_profile from public.user_profiles where id = v_actor and deactivated_at is null;
  if not found then raise exception 'Active user required'; end if;
  with updated as (
    update public.service_agreements a
    set invitation_status = 'accepted'
    where a.client_organization_id = v_profile.organization_id
      and a.invitation_status = 'invited'
    returning a.id, a.name, a.agreement_type, a.provider_organization_id
  ), logged as (
    insert into public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
    select u.provider_organization_id, v_actor, 'client_invitation_accepted', 'service_agreements', u.id,
      jsonb_build_object('client_organization_id', v_profile.organization_id, 'agreement_name', u.name, 'agreement_type', u.agreement_type, 'accepted_by_role', v_profile.role)
    from updated u
    returning 1
  )
  select count(*) into v_accepted from logged;
  return jsonb_build_object('accepted', v_accepted, 'organization_id', v_profile.organization_id);
end;
$$;
revoke all on function public.accept_client_invitation() from public, anon;
grant execute on function public.accept_client_invitation() to authenticated, service_role;
comment on function public.accept_client_invitation() is 'Called by an invited user after setting their password: marks every invited agreement naming their organisation as client accepted, audited per agreement. Idempotent (0 when nothing was pending).';

-- prepare_crm_client_invitation: find the agreement wherever a branch of the actor holds it; create it under the managing branch.
create or replace function public.prepare_crm_client_invitation(p_account_organization_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
as $$
DECLARE
  v_actor uuid := auth.uid();
  v_provider uuid;
  v_account public.organizations%rowtype;
  v_contact public.crm_contacts%rowtype;
  v_agreement public.service_agreements%rowtype;
  v_site_count integer;
  v_zone_count integer;
BEGIN
  SELECT organization_id INTO v_provider FROM public.user_profiles WHERE id = v_actor AND deactivated_at IS NULL;
  IF v_provider IS NULL OR NOT public.is_admin_for_org(v_provider) THEN RAISE EXCEPTION 'Active provider CRM administrator required'; END IF;
  SELECT * INTO v_account FROM public.organizations WHERE id = p_account_organization_id AND status = 'prospect' AND NOT active FOR UPDATE;
  IF NOT FOUND OR NOT public.crm_actor_can_manage_account(v_account.id) THEN RAISE EXCEPTION 'Managed prospect account not found'; END IF;

  SELECT * INTO v_contact FROM public.crm_contacts WHERE organization_id = v_account.id AND is_primary AND deactivated_at IS NULL ORDER BY updated_at DESC LIMIT 1;
  IF v_contact.email IS NULL AND v_account.contact_email IS NOT NULL THEN
    v_contact.email := lower(trim(v_account.contact_email));
  END IF;
  IF v_contact.email IS NULL THEN RAISE EXCEPTION 'A primary client contact email is required before inviting the client'; END IF;

  SELECT count(*) INTO v_site_count FROM public.client_sites WHERE client_organization_id = v_account.id AND active;
  SELECT count(*) INTO v_zone_count
  FROM public.location_zones zone
  JOIN public.locations location ON location.id = zone.location_id
  WHERE location.organization_id = v_account.id AND zone.is_active;
  IF v_site_count = 0 THEN RAISE EXCEPTION 'Add at least one active site before inviting the client'; END IF;
  IF v_zone_count = 0 THEN RAISE EXCEPTION 'Add at least one active zone before inviting the client'; END IF;

  SELECT * INTO v_agreement
  FROM public.service_agreements
  WHERE provider_organization_id = ANY(public.get_descendant_organizations(v_provider)) AND client_organization_id = v_account.id AND agreement_type = 'operational'
  ORDER BY CASE WHEN invitation_status = 'accepted' THEN 0 WHEN invitation_status = 'invited' THEN 1 ELSE 2 END, created_at DESC
  LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN
    -- the branch that manages the account holds the agreement; the actor's own organisation only when the account is parented to it
    INSERT INTO public.service_agreements (provider_organization_id, client_organization_id, name, starts_on, agreement_type, invitation_status, client_portal_access_mode, external_refs)
    VALUES (CASE WHEN v_account.parent_organization_id = ANY(public.get_descendant_organizations(v_provider)) THEN v_account.parent_organization_id ELSE v_provider END,
      v_account.id, v_account.name || ' service agreement', current_date, 'operational', 'not_invited', 'transparency_only', jsonb_build_object('created_for_client_invite', true, 'created_by', v_actor))
    RETURNING * INTO v_agreement;
  END IF;
  IF v_agreement.invitation_status = 'accepted' THEN RAISE EXCEPTION 'Client invitation has already been accepted'; END IF;

  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_provider, v_actor, 'crm_client_invitation_prepared', 'service_agreements', v_agreement.id,
    jsonb_build_object('account_organization_id', v_account.id, 'site_count', v_site_count, 'zone_count', v_zone_count, 'contact_email', v_contact.email));
  RETURN jsonb_build_object('account_organization_id', v_account.id, 'agreement_id', v_agreement.id, 'provider_organization_id', v_agreement.provider_organization_id, 'agreement_status', v_agreement.invitation_status, 'email', lower(trim(v_contact.email)), 'display_name', trim(coalesce(v_contact.first_name, '') || ' ' || coalesce(v_contact.last_name, '')), 'site_count', v_site_count, 'zone_count', v_zone_count);
END;
$$;


-- claim_first_org_user was executable by anon/authenticated: any signed-in user could seat themselves as master of an
-- organisation that had no users yet. Only invite-org (service role) may call it.
revoke all on function public.claim_first_org_user(uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.claim_first_org_user(uuid, uuid, text, text, text) to service_role;
