-- Custom reports reuse the governed monthly_report_packs review and delivery
-- lifecycle while preserving an exact, immutable-at-generation scope snapshot.
alter table public.monthly_report_packs
  add column if not exists report_kind text not null default 'monthly',
  add column if not exists report_scope jsonb not null default '{}'::jsonb,
  add column if not exists delivery_attempt_id uuid,
  add column if not exists delivery_started_at timestamptz,
  add column if not exists delivery_recipient text,
  add column if not exists pdf_source_updated_at timestamptz;

alter table public.monthly_report_packs
  drop constraint if exists monthly_report_packs_report_kind_check,
  add constraint monthly_report_packs_report_kind_check
    check (report_kind in ('monthly', 'custom')),
  drop constraint if exists monthly_report_packs_report_scope_check,
  add constraint monthly_report_packs_report_scope_check check (
    jsonb_typeof(report_scope) = 'object'
    and (
      report_kind = 'monthly'
      or ((
        report_scope->>'match_semantics' = 'or_within_dimensions_and_across_dimensions'
        and report_scope->>'privacy_tier' in ('operational_metadata', 'personal', 'sensitive_personal')
        and jsonb_typeof(report_scope->'site_ids') = 'array'
        and jsonb_typeof(report_scope->'zone_ids') = 'array'
        and jsonb_typeof(report_scope->'person_ids') = 'array'
        and jsonb_typeof(report_scope->'vehicle_ids') = 'array'
        and jsonb_typeof(report_scope->'sections') = 'array'
      ) is true)
    )
  );

comment on column public.monthly_report_packs.report_kind is
  'monthly for scheduled template packs; custom for an administrator-selected agreement scope.';
comment on column public.monthly_report_packs.report_scope is
  'Exact generation-time scope for a custom report. IDs are OR-matched within a dimension and AND-matched across populated dimensions.';
comment on column public.monthly_report_packs.delivery_attempt_id is
  'Opaque lease identifying the single email-delivery attempt currently allowed to update this pack.';
comment on column public.monthly_report_packs.delivery_started_at is
  'When email delivery was atomically claimed. An uncertain claim requires explicit provider review/republication before retry.';
comment on column public.monthly_report_packs.delivery_recipient is
  'Active primary client contact email bound inside the current delivery claim transaction.';
comment on column public.monthly_report_packs.pdf_source_updated_at is
  'Pack updated_at value whose content the current PDF renders. Equality means current; inequality means retained but stale until replacement.';

update public.monthly_report_packs
set pdf_source_updated_at = updated_at
where pdf_path is not null
  and pdf_source_updated_at is null;

create or replace function public.report_provider_custodian_for_actor(
  p_target_organization_id uuid,
  p_actor_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select exists (
    select 1
    from public.user_profiles profile
    where profile.id = p_actor_user_id
      and profile.deactivated_at is null
      and profile.role in ('grand_master', 'master', 'admin')
      and (
        profile.role = 'grand_master'
        or profile.organization_id = p_target_organization_id
        or p_target_organization_id = any(public.get_descendant_organizations(profile.organization_id))
        or (
          profile.employer_organization_id is not null
          and (
            profile.employer_organization_id = p_target_organization_id
            or p_target_organization_id = any(public.get_descendant_organizations(profile.employer_organization_id))
          )
        )
      )
  );
$$;

create or replace function public.is_report_provider_custodian_for_org(p_target_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select public.report_provider_custodian_for_actor(p_target_organization_id, auth.uid());
$$;

revoke all on function public.report_provider_custodian_for_actor(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.is_report_provider_custodian_for_org(uuid) from public, anon, authenticated, service_role;
grant execute on function public.is_report_provider_custodian_for_org(uuid) to authenticated;

create or replace function public.clear_report_pack_delivery_claim()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
declare
  v_content_changed boolean :=
    new.published_at is distinct from old.published_at
    or new.editorial is distinct from old.editorial
    or new.data is distinct from old.data
    or new.report_scope is distinct from old.report_scope;
  v_pdf_changed boolean :=
    new.pdf_path is distinct from old.pdf_path
    or new.pdf_mime_type is distinct from old.pdf_mime_type
    or new.pdf_sha256 is distinct from old.pdf_sha256
    or new.pdf_renderer_version is distinct from old.pdf_renderer_version
    or new.pdf_source_updated_at is distinct from old.pdf_source_updated_at;
  v_delivery_finalization boolean :=
    new.status is distinct from old.status
    and new.delivery_attempt_id = old.delivery_attempt_id
    and new.status in ('sent', 'failed');
begin
  if old.status = 'sent' and new is distinct from old then
    raise exception 'Sent report packs are immutable';
  end if;

  if auth.uid() is not null
     and not public.is_report_provider_custodian_for_org(old.organization_id) then
    raise exception 'Provider custodian access required';
  end if;

  if old.delivery_attempt_id is not null
     and old.delivery_started_at > clock_timestamp() - interval '10 minutes'
     and (v_content_changed or v_pdf_changed or new.status is distinct from old.status)
     and not v_delivery_finalization then
    raise exception 'Report email delivery is in progress; wait before changing this report';
  end if;

  if old.pdf_path is not null and new.pdf_path is null then
    new.pdf_path := old.pdf_path;
    new.pdf_mime_type := old.pdf_mime_type;
    new.pdf_sha256 := old.pdf_sha256;
    new.pdf_renderer_version := old.pdf_renderer_version;
    new.pdf_source_updated_at := old.pdf_source_updated_at;
  end if;

  if v_content_changed then
    new.delivery_attempt_id := null;
    new.delivery_started_at := null;
    new.delivery_recipient := null;
  end if;

  if new.status = 'generated'
     and new.published_at is not null
     and new.report_kind = 'custom'
     and coalesce(new.report_scope->>'privacy_tier', 'operational_metadata') <> 'operational_metadata'
     and not exists (
       select 1
       from public.service_agreements agreement
       join public.user_profiles client_profile
         on client_profile.organization_id = agreement.client_organization_id
        and client_profile.deactivated_at is null
        and client_profile.role = 'client_admin'
       where agreement.id = new.service_agreement_id
     ) then
    raise exception 'Personal and sensitive reports require an active client administrator before publication';
  end if;

  if v_delivery_finalization then
    if new.status = 'sent' and old.pdf_source_updated_at = old.updated_at then
      new.pdf_source_updated_at := new.updated_at;
    elsif new.status = 'failed' then
      new.pdf_source_updated_at := null;
    end if;
    new.delivery_attempt_id := null;
    new.delivery_started_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists clear_report_pack_delivery_claim on public.monthly_report_packs;
create trigger clear_report_pack_delivery_claim
before update on public.monthly_report_packs
for each row execute function public.clear_report_pack_delivery_claim();

create or replace function public.prevent_sent_report_pack_delete()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  if old.status = 'sent' then
    raise exception 'Sent report packs are immutable';
  end if;
  return old;
end;
$$;

drop trigger if exists prevent_sent_report_pack_delete on public.monthly_report_packs;
create trigger prevent_sent_report_pack_delete
before delete on public.monthly_report_packs
for each row execute function public.prevent_sent_report_pack_delete();

create index if not exists monthly_report_packs_kind_created_idx
  on public.monthly_report_packs(service_agreement_id, report_kind, created_at desc);

-- Report-pack writes are owned by governed security-definer RPCs and trusted
-- delivery functions. Browser roles do not write table rows directly.
drop policy if exists monthly_report_packs_insert on public.monthly_report_packs;
drop policy if exists monthly_report_packs_update on public.monthly_report_packs;
revoke insert, update, delete on table public.monthly_report_packs from anon, authenticated;

drop policy if exists monthly_report_packs_select on public.monthly_report_packs;
create policy monthly_report_packs_select
on public.monthly_report_packs
for select
to authenticated
using (
  public.is_report_provider_custodian_for_org(organization_id)
  or exists (
    select 1
    from public.service_agreements agreement
    join public.user_profiles client_profile
      on client_profile.id = auth.uid()
     and client_profile.organization_id = agreement.client_organization_id
     and client_profile.deactivated_at is null
     and client_profile.role in ('client_admin', 'client_officer', 'client_viewer')
    where agreement.id = monthly_report_packs.service_agreement_id
      and monthly_report_packs.status in ('generated', 'sent')
      and agreement.client_portal_reports_enabled
      and (
        monthly_report_packs.report_kind <> 'custom'
        or coalesce(monthly_report_packs.report_scope->>'privacy_tier', 'operational_metadata') = 'operational_metadata'
        or client_profile.role = 'client_admin'
      )
  )
);

create or replace function public.record_report_pack_pdf(
  p_pack_id uuid,
  p_expected_updated_at timestamptz,
  p_pdf_path text,
  p_pdf_sha256 text,
  p_renderer_version text,
  p_actor_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_actor uuid := p_actor_user_id;
  v_pack public.monthly_report_packs%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  if v_actor is null then raise exception 'Provider administrator identity required'; end if;
  select * into v_pack from public.monthly_report_packs where id = p_pack_id for update;
  if not found then raise exception 'Report pack not found'; end if;
  if not public.report_provider_custodian_for_actor(v_pack.organization_id, v_actor) then
    raise exception 'Provider administrator access required';
  end if;
  if v_pack.status not in ('draft', 'generated') then raise exception 'Only draft or published report packs can be rendered'; end if;
  if v_pack.delivery_attempt_id is not null then raise exception 'Report email delivery is in progress or requires review before retry'; end if;
  if v_pack.updated_at is distinct from p_expected_updated_at then raise exception 'Report changed while the PDF was rendering'; end if;
  if nullif(btrim(coalesce(p_pdf_path, '')), '') is null
     or nullif(btrim(coalesce(p_pdf_sha256, '')), '') is null
     or nullif(btrim(coalesce(p_renderer_version, '')), '') is null then
    raise exception 'Complete PDF metadata is required';
  end if;
  if position(format('org/%s/report-packs/%s/', v_pack.organization_id, v_pack.id) in p_pdf_path) <> 1
     or p_pdf_sha256 !~ '^[0-9a-f]{64}$'
     or length(p_renderer_version) > 160 then
    raise exception 'Invalid report PDF metadata';
  end if;

  update public.monthly_report_packs
  set pdf_path = p_pdf_path,
      pdf_mime_type = 'application/pdf',
      pdf_sha256 = p_pdf_sha256,
      pdf_renderer_version = p_renderer_version,
      pdf_source_updated_at = v_now,
      updated_at = v_now
  where id = p_pack_id;

  insert into public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (v_pack.organization_id, v_actor, 'monthly_report_pack_pdf_generated', 'monthly_report_packs', p_pack_id,
    jsonb_build_object('pdf_path', p_pdf_path, 'pdf_sha256', p_pdf_sha256, 'renderer_version', p_renderer_version,
      'replaced_pdf_path', v_pack.pdf_path));

  return jsonb_build_object('id', p_pack_id, 'pdf_path', p_pdf_path, 'pdf_mime_type', 'application/pdf',
    'pdf_sha256', p_pdf_sha256, 'pdf_renderer_version', p_renderer_version, 'pdf_source_updated_at', v_now);
end;
$$;

create or replace function public.claim_report_pack_email_delivery(
  p_pack_id uuid,
  p_expected_updated_at timestamptz,
  p_delivery_attempt_id uuid,
  p_actor_user_id uuid,
  p_requested_recipient text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_actor uuid := p_actor_user_id;
  v_pack public.monthly_report_packs%rowtype;
  v_recipient text;
  v_recipient_count integer;
begin
  if v_actor is null or p_delivery_attempt_id is null then raise exception 'Provider administrator and delivery attempt are required'; end if;
  select * into v_pack from public.monthly_report_packs where id = p_pack_id for update;
  if not found then raise exception 'Report pack not found'; end if;
  if not public.report_provider_custodian_for_actor(v_pack.organization_id, v_actor) then
    raise exception 'Provider administrator access required';
  end if;
  if v_pack.status = 'sent' then
    return jsonb_build_object('status', 'sent', 'sent_to', v_pack.sent_to);
  end if;
  if v_pack.status <> 'generated' or v_pack.published_at is null or v_pack.delivery_channel <> 'email' then
    raise exception 'Review and publish this email report before sending it';
  end if;
  if v_pack.updated_at is distinct from p_expected_updated_at
     or v_pack.pdf_path is null
     or v_pack.pdf_source_updated_at is distinct from v_pack.updated_at then
    raise exception 'Report changed before delivery; generate a current reviewed PDF';
  end if;
  if v_pack.delivery_attempt_id is not null then
    raise exception 'Report delivery is already in progress; review and republish before retrying an uncertain attempt';
  end if;

  select count(*)::integer, min(btrim(contact.email))
  into v_recipient_count, v_recipient
  from public.service_agreements agreement
  join public.crm_contacts contact
    on contact.organization_id = agreement.client_organization_id
   and contact.is_primary
   and contact.deactivated_at is null
   and nullif(btrim(contact.email), '') is not null
  where agreement.id = v_pack.service_agreement_id;

  if v_recipient_count <> 1 or v_recipient is null then
    raise exception 'Exactly one active primary client contact email is required';
  end if;
  if nullif(btrim(coalesce(p_requested_recipient, '')), '') is not null
     and lower(btrim(p_requested_recipient)) <> lower(v_recipient) then
    raise exception 'Recipient must match the active primary client contact';
  end if;
  if v_pack.report_kind = 'custom'
     and coalesce(v_pack.report_scope->>'privacy_tier', 'operational_metadata') <> 'operational_metadata'
     and not exists (
       select 1
       from public.service_agreements agreement
       join public.user_profiles client_admin
         on client_admin.organization_id = agreement.client_organization_id
        and client_admin.deactivated_at is null
        and client_admin.role = 'client_admin'
        and lower(btrim(coalesce(client_admin.email, ''))) = lower(v_recipient)
       where agreement.id = v_pack.service_agreement_id
     ) then
    raise exception 'Personal report email recipient must be an active client administrator';
  end if;

  update public.monthly_report_packs
  set delivery_attempt_id = p_delivery_attempt_id,
      delivery_started_at = clock_timestamp(),
      delivery_recipient = v_recipient,
      delivery_error = null
  where id = p_pack_id;

  insert into public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (v_pack.organization_id, v_actor, 'monthly_report_pack_delivery_claimed', 'monthly_report_packs', p_pack_id,
    jsonb_build_object('delivery_attempt_id', p_delivery_attempt_id, 'recipient', v_recipient));
  return jsonb_build_object('status', 'claimed', 'delivery_attempt_id', p_delivery_attempt_id, 'recipient', v_recipient);
end;
$$;

create or replace function public.finalize_report_pack_email_delivery(
  p_pack_id uuid,
  p_delivery_attempt_id uuid,
  p_outcome text,
  p_sent_to text default null,
  p_error text default null,
  p_actor_user_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_actor uuid := p_actor_user_id;
  v_pack public.monthly_report_packs%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  if v_actor is null or p_delivery_attempt_id is null then raise exception 'Provider administrator and delivery attempt are required'; end if;
  if p_outcome not in ('sent', 'failed') then raise exception 'Delivery outcome must be sent or failed'; end if;
  select * into v_pack from public.monthly_report_packs where id = p_pack_id for update;
  if not found then raise exception 'Report pack not found'; end if;
  if not public.report_provider_custodian_for_actor(v_pack.organization_id, v_actor) then
    raise exception 'Provider administrator access required';
  end if;
  if v_pack.status = 'sent' and p_outcome = 'sent' then
    return jsonb_build_object('status', 'sent', 'sent_to', v_pack.sent_to, 'already_sent', true);
  end if;
  if v_pack.status <> 'generated' or v_pack.delivery_attempt_id is distinct from p_delivery_attempt_id then
    raise exception 'Report delivery claim no longer matches';
  end if;
  if p_outcome = 'sent'
     and (v_pack.delivery_recipient is null
          or lower(btrim(coalesce(p_sent_to, ''))) <> lower(v_pack.delivery_recipient)) then
    raise exception 'Sent delivery recipient must match the claimed recipient';
  end if;

  update public.monthly_report_packs
  set status = p_outcome,
      sent_at = case when p_outcome = 'sent' then v_now else null end,
      sent_to = case when p_outcome = 'sent' then v_pack.delivery_recipient else null end,
      delivery_error = case when p_outcome = 'failed' then coalesce(p_error, 'Email delivery failed') else null end,
      updated_at = v_now
  where id = p_pack_id;

  insert into public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (v_pack.organization_id, v_actor,
    case when p_outcome = 'sent' then 'monthly_report_pack_sent' else 'monthly_report_pack_send_failed' end,
    'monthly_report_packs', p_pack_id,
    jsonb_strip_nulls(jsonb_build_object('delivery_attempt_id', p_delivery_attempt_id, 'sent_to', v_pack.delivery_recipient, 'error', p_error)));
  return jsonb_build_object('status', p_outcome, 'sent_to', case when p_outcome = 'sent' then v_pack.delivery_recipient else null end);
end;
$$;

revoke all on function public.record_report_pack_pdf(uuid, timestamptz, text, text, text, uuid) from public, anon, authenticated, service_role;
grant execute on function public.record_report_pack_pdf(uuid, timestamptz, text, text, text, uuid) to service_role;
revoke all on function public.claim_report_pack_email_delivery(uuid, timestamptz, uuid, uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.claim_report_pack_email_delivery(uuid, timestamptz, uuid, uuid, text) to service_role;
revoke all on function public.finalize_report_pack_email_delivery(uuid, uuid, text, text, text, uuid) from public, anon, authenticated, service_role;
grant execute on function public.finalize_report_pack_email_delivery(uuid, uuid, text, text, text, uuid) to service_role;

-- The bucket's org-prefix rule is too broad for personal custom reports.
-- A report-pack object is readable only through a currently referenced pack
-- row that the caller can itself read under monthly_report_packs RLS.
create or replace function public.can_read_current_report_pack_pdf(p_object_name text)
returns boolean
language sql
stable
security invoker
set search_path = pg_catalog
as $$
  select exists (
    select 1
    from public.monthly_report_packs report_pack
    where report_pack.pdf_path = p_object_name
      and report_pack.pdf_source_updated_at = report_pack.updated_at
  );
$$;

revoke all on function public.can_read_current_report_pack_pdf(text) from public, anon, authenticated, service_role;
grant execute on function public.can_read_current_report_pack_pdf(text) to authenticated;

do $storage_policy$
begin
  if to_regclass('storage.objects') is not null then
    execute 'drop policy if exists bob_uploads_select on storage.objects';
    execute $select_policy$
      create policy bob_uploads_select on storage.objects
      for select
      to authenticated
      using (
        bucket_id = 'bob-uploads'
        and (
          (
            (storage.foldername(name))[1] in ('org', 'synthetic')
            and (storage.foldername(name))[2] ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
            and public.org_access_allowed(((storage.foldername(name))[2])::uuid)
            and (
              (storage.foldername(name))[3] is distinct from 'report-packs'
              or public.can_read_current_report_pack_pdf(storage.objects.name)
            )
          )
          or (
            (storage.foldername(name))[1] = 'desktop'
            and (storage.foldername(name))[2] = auth.uid()::text
          )
        )
      )
    $select_policy$;

    execute 'drop policy if exists bob_uploads_insert on storage.objects';
    execute $insert_policy$
      create policy bob_uploads_insert on storage.objects
      for insert
      to authenticated
      with check (
        bucket_id = 'bob-uploads'
        and (
          (
            (storage.foldername(name))[1] in ('org', 'synthetic')
            and (storage.foldername(name))[2] ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
            and public.org_access_allowed(((storage.foldername(name))[2])::uuid)
            and (
              (storage.foldername(name))[3] is distinct from 'report-packs'
              or public.is_report_provider_custodian_for_org(((storage.foldername(name))[2])::uuid)
            )
          )
          or (
            (storage.foldername(name))[1] = 'desktop'
            and (storage.foldername(name))[2] = auth.uid()::text
          )
        )
      )
    $insert_policy$;
  end if;
end
$storage_policy$;

create or replace function public.get_custom_report_scope_options(
  p_service_agreement_id uuid,
  p_period_start date,
  p_period_end date
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_actor uuid := auth.uid();
  v_agreement record;
  v_start_ts timestamptz := p_period_start::timestamptz;
  v_end_ts timestamptz := p_period_end::timestamptz + interval '1 day';
  v_sites jsonb;
  v_zones jsonb;
  v_people jsonb;
  v_vehicles jsonb;
begin
  if v_actor is null then
    raise exception 'Authenticated provider administrator required';
  end if;
  if p_period_start is null or p_period_end is null
     or p_period_start > p_period_end
     or p_period_end - p_period_start > 366 then
    raise exception 'Select a valid report period of 366 days or less';
  end if;

  select agreement.id, agreement.provider_organization_id,
      agreement.client_organization_id, agreement.name,
      agreement.starts_on, agreement.ends_on
  into v_agreement
  from public.service_agreements agreement
  where agreement.id = p_service_agreement_id
    and agreement.agreement_type = 'operational'
    and agreement.invitation_status = 'accepted';

  if v_agreement.id is null then
    raise exception 'Accepted operational service agreement not found';
  end if;
  if (v_agreement.starts_on is not null and p_period_start < v_agreement.starts_on)
     or (v_agreement.ends_on is not null and p_period_end > v_agreement.ends_on) then
    raise exception 'Report period must fall within the service agreement term';
  end if;
  if not public.is_report_provider_custodian_for_org(v_agreement.provider_organization_id) then
    raise exception 'Provider administrator access required';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', site.id,
           'name', site.name,
           'address', site.address
         ) order by site.name, site.id), '[]'::jsonb)
  into v_sites
  from public.service_agreement_locations link
  join public.client_sites site on site.id = link.site_id
  where link.service_agreement_id = v_agreement.id
    and link.status = 'active'
    and site.active;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', zone.id,
           'name', zone.name,
           'zone_type', zone.zone_type
         ) order by zone.name, zone.id), '[]'::jsonb)
  into v_zones
  from public.service_agreement_locations link
  join public.location_zones zone on zone.id = link.zone_id
  where link.service_agreement_id = v_agreement.id
    and link.status = 'active'
    and zone.is_active;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', person.id,
           'name', coalesce(person.display_name, 'Unnamed person')
         ) order by person.display_name, person.id), '[]'::jsonb)
  into v_people
  from public.canonical_person_public person
  where exists (
    select 1
    from public.observations observation
    where observation.organization_id = v_agreement.provider_organization_id
      and observation.observed_at >= v_start_ts
      and observation.observed_at < v_end_ts
      and observation.canonical_person_id = person.id
      and exists (
        select 1
        from public.service_agreement_locations link
        where link.service_agreement_id = v_agreement.id
          and link.status = 'active'
          and (
            (link.site_id is not null and link.site_id = observation.site_id)
            or (link.zone_id is not null and link.zone_id = observation.zone_id)
          )
      )
  );

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', vehicle.id,
           'plate', vehicle.plate_number,
           'make', vehicle.make,
           'model', vehicle.model
         ) order by vehicle.plate_number, vehicle.id), '[]'::jsonb)
  into v_vehicles
  from public.canonical_vehicle_public vehicle
  where exists (
    select 1
    from public.observations observation
    where observation.organization_id = v_agreement.provider_organization_id
      and observation.observed_at >= v_start_ts
      and observation.observed_at < v_end_ts
      and observation.canonical_vehicle_id = vehicle.id
      and exists (
        select 1
        from public.service_agreement_locations link
        where link.service_agreement_id = v_agreement.id
          and link.status = 'active'
          and (
            (link.site_id is not null and link.site_id = observation.site_id)
            or (link.zone_id is not null and link.zone_id = observation.zone_id)
          )
      )
  );

  return jsonb_build_object(
    'agreement', jsonb_build_object(
      'id', v_agreement.id,
      'name', v_agreement.name,
      'provider_organization_id', v_agreement.provider_organization_id,
      'client_organization_id', v_agreement.client_organization_id
    ),
    'sites', v_sites,
    'zones', v_zones,
    'people', v_people,
    'vehicles', v_vehicles,
    'supported_sections', jsonb_build_array(
      'summary', 'observations', 'breaches', 'incidents', 'checkpoint_visits'
    )
  );
end;
$$;

comment on function public.get_custom_report_scope_options(uuid, date, date) is
  'Returns only agreement-linked Site/Zone facets and canonical people/vehicles with tenant-scoped observations in the selected period. Private canonical fields are never returned.';

revoke all on function public.get_custom_report_scope_options(uuid, date, date)
  from public, anon, authenticated, service_role;
grant execute on function public.get_custom_report_scope_options(uuid, date, date)
  to authenticated;

create or replace function public.custom_report_source_snapshot(
  p_provider_organization_id uuid,
  p_service_agreement_id uuid,
  p_start_ts timestamptz,
  p_end_ts timestamptz,
  p_site_ids uuid[],
  p_zone_ids uuid[],
  p_person_ids uuid[],
  p_vehicle_ids uuid[],
  p_has_entity_scope boolean,
  p_sections text[]
)
returns jsonb
language sql
stable
set search_path = pg_catalog
as $$
with scoped_observations as not materialized (
  select observation.id,
    observation.observed_at,
    observation.site_id,
    site.name as site_name,
    observation.zone_id,
    zone.name as zone_name,
    observation.canonical_person_id,
    coalesce(person.display_name, 'Unnamed person') as person_name,
    observation.canonical_vehicle_id,
    vehicle.plate_number as vehicle_plate,
    observation.plate_number,
    observation.module_key,
    observation.is_compliant,
    observation.compliance_reason
  from public.observations observation
  left join public.client_sites site on site.id = observation.site_id
  left join public.location_zones zone on zone.id = observation.zone_id
  left join public.canonical_person_public person on person.id = observation.canonical_person_id
  left join public.canonical_vehicle_public vehicle on vehicle.id = observation.canonical_vehicle_id
  where ('summary' = any(p_sections) or 'observations' = any(p_sections) or 'breaches' = any(p_sections))
    and observation.organization_id = p_provider_organization_id
    and observation.observed_at >= p_start_ts
    and observation.observed_at < p_end_ts
    and exists (
      select 1 from public.service_agreement_locations link
      where link.service_agreement_id = p_service_agreement_id
        and link.status = 'active'
        and (
          (link.site_id is not null and link.site_id = observation.site_id)
          or (link.zone_id is not null and link.zone_id = observation.zone_id)
        )
    )
    and (
      cardinality(p_site_ids) + cardinality(p_zone_ids) = 0
      or observation.site_id = any(p_site_ids)
      or observation.zone_id = any(p_zone_ids)
    )
    and (cardinality(p_person_ids) = 0 or observation.canonical_person_id = any(p_person_ids))
    and (cardinality(p_vehicle_ids) = 0 or observation.canonical_vehicle_id = any(p_vehicle_ids))
), limited_observations as materialized (
  select * from scoped_observations
  order by observed_at, id
  limit 1001
), scoped_breaches as not materialized (
  select alert.id,
    alert.observation_id,
    alert.created_at,
    observation.site_id,
    observation.site_name,
    observation.zone_id,
    observation.zone_name,
    alert.plate_number,
    alert.breach_type,
    alert.status
  from public.breach_alerts alert
  join scoped_observations observation on observation.id = alert.observation_id
  where ('summary' = any(p_sections) or 'breaches' = any(p_sections))
    and alert.organization_id = p_provider_organization_id
), limited_breaches as materialized (
  select * from scoped_breaches
  order by created_at, id
  limit 1001
), scoped_incidents as not materialized (
  select incident.id,
    incident.occurred_at,
    incident.client_site_id as site_id,
    site.name as site_name,
    incident.zone_id,
    zone.name as zone_name,
    incident.incident_type,
    incident.severity,
    incident.status
  from public.incidents incident
  left join public.client_sites site on site.id = incident.client_site_id
  left join public.location_zones zone on zone.id = incident.zone_id
  where ('summary' = any(p_sections) or 'incidents' = any(p_sections))
    and not p_has_entity_scope
    and incident.organization_id = p_provider_organization_id
    and incident.occurred_at >= p_start_ts
    and incident.occurred_at < p_end_ts
    and exists (
      select 1 from public.service_agreement_locations link
      where link.service_agreement_id = p_service_agreement_id
        and link.status = 'active'
        and (
          (link.site_id is not null and link.site_id = incident.client_site_id)
          or (link.zone_id is not null and link.zone_id = incident.zone_id)
        )
    )
    and (
      cardinality(p_site_ids) + cardinality(p_zone_ids) = 0
      or incident.client_site_id = any(p_site_ids)
      or incident.zone_id = any(p_zone_ids)
    )
), limited_incidents as materialized (
  select * from scoped_incidents
  order by occurred_at, id
  limit 1001
), scoped_checkpoints as not materialized (
  select visit.id,
    visit.visited_at,
    visit.checkpoint_id,
    visit.route_checkpoint_id,
    case when visit.route_checkpoint_id is not null then 'route' else 'legacy' end as checkpoint_kind,
    coalesce(route_checkpoint.name, checkpoint.name) as checkpoint_name,
    coalesce(route.site_id, checkpoint.client_site_id) as site_id,
    site.name as site_name,
    checkpoint.zone_id,
    zone.name as zone_name,
    visit.within_radius,
    visit.scan_method
  from public.patrol_checkpoint_visits visit
  left join public.patrol_checkpoints checkpoint
    on checkpoint.id = visit.checkpoint_id
   and checkpoint.organization_id = p_provider_organization_id
  left join public.patrol_route_checkpoints route_checkpoint
    on route_checkpoint.id = visit.route_checkpoint_id
  left join public.patrol_routes route
    on route.id = route_checkpoint.patrol_route_id
   and route.organization_id = p_provider_organization_id
  left join public.client_sites site
    on site.id = coalesce(route.site_id, checkpoint.client_site_id)
  left join public.location_zones zone on zone.id = checkpoint.zone_id
  where ('summary' = any(p_sections) or 'checkpoint_visits' = any(p_sections))
    and not p_has_entity_scope
    and visit.organization_id = p_provider_organization_id
    and visit.visited_at >= p_start_ts
    and visit.visited_at < p_end_ts
    and (
      (visit.checkpoint_id is not null and checkpoint.id is not null)
      or (visit.route_checkpoint_id is not null and route_checkpoint.id is not null and route.id is not null)
    )
    and exists (
      select 1 from public.service_agreement_locations link
      where link.service_agreement_id = p_service_agreement_id
        and link.status = 'active'
        and (
          (link.site_id is not null and link.site_id = coalesce(route.site_id, checkpoint.client_site_id))
          or (link.zone_id is not null and link.zone_id = checkpoint.zone_id)
        )
    )
    and (
      cardinality(p_site_ids) + cardinality(p_zone_ids) = 0
      or coalesce(route.site_id, checkpoint.client_site_id) = any(p_site_ids)
      or checkpoint.zone_id = any(p_zone_ids)
    )
), limited_checkpoints as materialized (
  select * from scoped_checkpoints
  order by visited_at, id
  limit 1001
)
select jsonb_build_object(
  'observation_count', (select count(*) from scoped_observations),
  'compliant_count', (select count(*) from scoped_observations where is_compliant is true),
  'non_compliant_count', (select count(*) from scoped_observations where is_compliant is false),
  'breach_count', (select count(*) from scoped_breaches),
  'incident_count', (select count(*) from scoped_incidents),
  'checkpoint_count', (select count(*) from scoped_checkpoints),
  'observations', case when 'observations' = any(p_sections) then coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', observation.id,
      'observed_at', observation.observed_at,
      'site_id', observation.site_id,
      'site_name', observation.site_name,
      'zone_id', observation.zone_id,
      'zone_name', observation.zone_name,
      'canonical_person_id', observation.canonical_person_id,
      'person_name', observation.person_name,
      'canonical_vehicle_id', observation.canonical_vehicle_id,
      'vehicle_plate', observation.vehicle_plate,
      'plate_number', observation.plate_number,
      'module_key', observation.module_key,
      'is_compliant', observation.is_compliant,
      'compliance_reason', observation.compliance_reason
    ) order by observation.observed_at, observation.id)
    from limited_observations observation
  ), '[]'::jsonb) else '[]'::jsonb end,
  'breaches', case when 'breaches' = any(p_sections) then coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', alert.id,
      'observation_id', alert.observation_id,
      'created_at', alert.created_at,
      'site_id', alert.site_id,
      'site_name', alert.site_name,
      'zone_id', alert.zone_id,
      'zone_name', alert.zone_name,
      'plate_number', alert.plate_number,
      'breach_type', alert.breach_type,
      'status', alert.status
    ) order by alert.created_at, alert.id)
    from limited_breaches alert
  ), '[]'::jsonb) else '[]'::jsonb end,
  'incidents', case when 'incidents' = any(p_sections) then coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', incident.id,
      'occurred_at', incident.occurred_at,
      'site_id', incident.site_id,
      'site_name', incident.site_name,
      'zone_id', incident.zone_id,
      'zone_name', incident.zone_name,
      'incident_type', incident.incident_type,
      'severity', incident.severity,
      'status', incident.status
    ) order by incident.occurred_at, incident.id)
    from limited_incidents incident
  ), '[]'::jsonb) else '[]'::jsonb end,
  'checkpoint_visits', case when 'checkpoint_visits' = any(p_sections) then coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', visit.id,
      'visited_at', visit.visited_at,
      'checkpoint_id', visit.checkpoint_id,
      'route_checkpoint_id', visit.route_checkpoint_id,
      'checkpoint_kind', visit.checkpoint_kind,
      'checkpoint_name', visit.checkpoint_name,
      'site_id', visit.site_id,
      'site_name', visit.site_name,
      'zone_id', visit.zone_id,
      'zone_name', visit.zone_name,
      'within_radius', visit.within_radius,
      'scan_method', visit.scan_method
    ) order by visit.visited_at, visit.id)
    from limited_checkpoints visit
  ), '[]'::jsonb) else '[]'::jsonb end,
  'scope_labels', jsonb_build_object(
    'sites', coalesce((
      select jsonb_agg(jsonb_build_object('id', site.id, 'name', site.name, 'address', site.address) order by site.name, site.id)
      from public.client_sites site where site.id = any(p_site_ids)
    ), '[]'::jsonb),
    'zones', coalesce((
      select jsonb_agg(jsonb_build_object('id', zone.id, 'name', zone.name, 'zone_type', zone.zone_type) order by zone.name, zone.id)
      from public.location_zones zone where zone.id = any(p_zone_ids)
    ), '[]'::jsonb),
    'people', coalesce((
      select jsonb_agg(jsonb_build_object('id', person.id, 'name', coalesce(person.display_name, 'Unnamed person')) order by person.display_name, person.id)
      from public.canonical_person_public person where person.id = any(p_person_ids)
    ), '[]'::jsonb),
    'vehicles', coalesce((
      select jsonb_agg(jsonb_build_object('id', vehicle.id, 'plate', vehicle.plate_number, 'make', vehicle.make, 'model', vehicle.model) order by vehicle.plate_number, vehicle.id)
      from public.canonical_vehicle_public vehicle where vehicle.id = any(p_vehicle_ids)
    ), '[]'::jsonb)
  )
);
$$;

revoke all on function public.custom_report_source_snapshot(uuid, uuid, timestamptz, timestamptz, uuid[], uuid[], uuid[], uuid[], boolean, text[])
  from public, anon, authenticated, service_role;

create or replace function public.generate_custom_report_pack(
  p_service_agreement_id uuid,
  p_period_start date,
  p_period_end date,
  p_title text,
  p_site_ids uuid[],
  p_zone_ids uuid[],
  p_person_ids uuid[],
  p_vehicle_ids uuid[],
  p_sections text[]
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_actor uuid := auth.uid();
  v_agreement record;
  v_start_ts timestamptz := p_period_start::timestamptz;
  v_end_ts timestamptz := p_period_end::timestamptz + interval '1 day';
  v_site_ids uuid[];
  v_zone_ids uuid[];
  v_person_ids uuid[];
  v_vehicle_ids uuid[];
  v_sections text[];
  v_invalid_sections text;
  v_has_entity_scope boolean;
  v_privacy_tier text;
  v_observation_count integer := 0;
  v_compliant_count integer := 0;
  v_non_compliant_count integer := 0;
  v_breach_count integer := 0;
  v_incident_count integer := 0;
  v_checkpoint_count integer := 0;
  v_observations jsonb := '[]'::jsonb;
  v_breaches jsonb := '[]'::jsonb;
  v_incidents jsonb := '[]'::jsonb;
  v_checkpoint_visits jsonb := '[]'::jsonb;
  v_snapshot jsonb;
  v_scope_labels jsonb;
  v_report_scope jsonb;
  v_data jsonb := '{}'::jsonb;
  v_pack_id uuid := gen_random_uuid();
begin
  if v_actor is null then
    raise exception 'Authenticated provider administrator required';
  end if;
  if p_period_start is null or p_period_end is null
     or p_period_start > p_period_end
     or p_period_end - p_period_start > 366 then
    raise exception 'Select a valid report period of 366 days or less';
  end if;
  if nullif(btrim(coalesce(p_title, '')), '') is null or length(p_title) > 160 then
    raise exception 'A report title of 160 characters or less is required';
  end if;

  select coalesce(array_agg(item order by item), '{}'::uuid[])
  into v_site_ids
  from (select distinct unnest(coalesce(p_site_ids, '{}'::uuid[])) as item) selected
  where item is not null;
  select coalesce(array_agg(item order by item), '{}'::uuid[])
  into v_zone_ids
  from (select distinct unnest(coalesce(p_zone_ids, '{}'::uuid[])) as item) selected
  where item is not null;
  select coalesce(array_agg(item order by item), '{}'::uuid[])
  into v_person_ids
  from (select distinct unnest(coalesce(p_person_ids, '{}'::uuid[])) as item) selected
  where item is not null;
  select coalesce(array_agg(item order by item), '{}'::uuid[])
  into v_vehicle_ids
  from (select distinct unnest(coalesce(p_vehicle_ids, '{}'::uuid[])) as item) selected
  where item is not null;
  select coalesce(array_agg(item order by item), '{}'::text[])
  into v_sections
  from (
    select distinct lower(btrim(value)) as item
    from unnest(coalesce(p_sections, '{}'::text[])) value
    where nullif(btrim(value), '') is not null
  ) selected;

  if cardinality(v_site_ids) > 100 or cardinality(v_zone_ids) > 100
     or cardinality(v_person_ids) > 100 or cardinality(v_vehicle_ids) > 100 then
    raise exception 'Each custom report scope is limited to 100 selected records per dimension';
  end if;
  if cardinality(v_sections) = 0 then
    raise exception 'Select at least one report section';
  end if;
  select string_agg(section, ', ' order by section)
  into v_invalid_sections
  from unnest(v_sections) section
  where section <> all(array['summary', 'observations', 'breaches', 'incidents', 'checkpoint_visits']);
  if v_invalid_sections is not null then
    raise exception 'Unsupported custom report section: %', v_invalid_sections;
  end if;

  select agreement.id, agreement.provider_organization_id,
      agreement.client_organization_id, agreement.name,
      agreement.starts_on, agreement.ends_on
  into v_agreement
  from public.service_agreements agreement
  where agreement.id = p_service_agreement_id
    and agreement.agreement_type = 'operational'
    and agreement.invitation_status = 'accepted';

  if v_agreement.id is null then
    raise exception 'Accepted operational service agreement not found';
  end if;
  if (v_agreement.starts_on is not null and p_period_start < v_agreement.starts_on)
     or (v_agreement.ends_on is not null and p_period_end > v_agreement.ends_on) then
    raise exception 'Report period must fall within the service agreement term';
  end if;
  if not public.is_report_provider_custodian_for_org(v_agreement.provider_organization_id) then
    raise exception 'Provider administrator access required';
  end if;

  if exists (
    select 1 from unnest(v_site_ids) selected(id)
    where not exists (
      select 1 from public.service_agreement_locations link
      where link.service_agreement_id = v_agreement.id
        and link.site_id = selected.id
        and link.status = 'active'
    )
  ) or exists (
    select 1 from unnest(v_zone_ids) selected(id)
    where not exists (
      select 1 from public.service_agreement_locations link
      where link.service_agreement_id = v_agreement.id
        and link.zone_id = selected.id
        and link.status = 'active'
    )
  ) then
    raise exception 'Selected Site or Zone is outside this agreement';
  end if;

  if exists (
    select 1 from unnest(v_person_ids) selected(id)
    where not exists (
      select 1
      from public.observations observation
      where observation.organization_id = v_agreement.provider_organization_id
        and observation.observed_at >= v_start_ts
        and observation.observed_at < v_end_ts
        and observation.canonical_person_id = selected.id
        and exists (
          select 1 from public.service_agreement_locations link
          where link.service_agreement_id = v_agreement.id
            and link.status = 'active'
            and (
              (link.site_id is not null and link.site_id = observation.site_id)
              or (link.zone_id is not null and link.zone_id = observation.zone_id)
            )
        )
    )
  ) then
    raise exception 'Selected person is outside this agreement and reporting period';
  end if;

  if exists (
    select 1 from unnest(v_vehicle_ids) selected(id)
    where not exists (
      select 1
      from public.observations observation
      where observation.organization_id = v_agreement.provider_organization_id
        and observation.observed_at >= v_start_ts
        and observation.observed_at < v_end_ts
        and observation.canonical_vehicle_id = selected.id
        and exists (
          select 1 from public.service_agreement_locations link
          where link.service_agreement_id = v_agreement.id
            and link.status = 'active'
            and (
              (link.site_id is not null and link.site_id = observation.site_id)
              or (link.zone_id is not null and link.zone_id = observation.zone_id)
            )
        )
    )
  ) then
    raise exception 'Selected vehicle is outside this agreement and reporting period';
  end if;

  v_has_entity_scope := cardinality(v_person_ids) > 0 or cardinality(v_vehicle_ids) > 0;
  v_privacy_tier := case
    when array_position(v_sections, 'incidents') is not null then 'sensitive_personal'
    when v_has_entity_scope
      or array_position(v_sections, 'observations') is not null
      or array_position(v_sections, 'breaches') is not null
      or array_position(v_sections, 'checkpoint_visits') is not null then 'personal'
    else 'operational_metadata'
  end;
  if v_has_entity_scope
     and (array_position(v_sections, 'incidents') is not null
          or array_position(v_sections, 'checkpoint_visits') is not null) then
    raise exception 'Incident and checkpoint sections do not have a governed person or vehicle link';
  end if;

  v_snapshot := public.custom_report_source_snapshot(
    v_agreement.provider_organization_id,
    v_agreement.id,
    v_start_ts,
    v_end_ts,
    v_site_ids,
    v_zone_ids,
    v_person_ids,
    v_vehicle_ids,
    v_has_entity_scope,
    v_sections
  );
  v_observation_count := (v_snapshot->>'observation_count')::integer;
  v_compliant_count := (v_snapshot->>'compliant_count')::integer;
  v_non_compliant_count := (v_snapshot->>'non_compliant_count')::integer;
  v_breach_count := (v_snapshot->>'breach_count')::integer;
  v_incident_count := (v_snapshot->>'incident_count')::integer;
  v_checkpoint_count := (v_snapshot->>'checkpoint_count')::integer;
  v_observations := v_snapshot->'observations';
  v_breaches := v_snapshot->'breaches';
  v_incidents := v_snapshot->'incidents';
  v_checkpoint_visits := v_snapshot->'checkpoint_visits';
  v_scope_labels := v_snapshot->'scope_labels';

  if array_position(v_sections, 'observations') is not null and v_observation_count > 1000 then
    raise exception 'Custom report scope exceeds 1000 observations; narrow the date or entity scope';
  end if;

  if array_position(v_sections, 'breaches') is not null and v_breach_count > 1000 then
    raise exception 'Custom report scope exceeds 1000 breaches; narrow the date or entity scope';
  end if;

  if array_position(v_sections, 'incidents') is not null and v_incident_count > 1000 then
    raise exception 'Custom report scope exceeds 1000 incidents; narrow the date or place scope';
  end if;

  if array_position(v_sections, 'checkpoint_visits') is not null and v_checkpoint_count > 1000 then
    raise exception 'Custom report scope exceeds 1000 checkpoint visits; narrow the date or place scope';
  end if;

  v_report_scope := jsonb_build_object(
    'version', 1,
    'agreement_id', v_agreement.id,
    'selection_mode', case
      when cardinality(v_site_ids) + cardinality(v_zone_ids) + cardinality(v_person_ids) + cardinality(v_vehicle_ids) = 0
        then 'all_agreement_activity'
      else 'selected_entities'
    end,
    'privacy_tier', v_privacy_tier,
    'match_semantics', 'or_within_dimensions_and_across_dimensions',
    'site_ids', to_jsonb(v_site_ids),
    'zone_ids', to_jsonb(v_zone_ids),
    'person_ids', to_jsonb(v_person_ids),
    'vehicle_ids', to_jsonb(v_vehicle_ids),
    'sections', to_jsonb(v_sections),
    'labels', v_scope_labels
  );

  if array_position(v_sections, 'summary') is not null then
    v_data := v_data || jsonb_build_object('summary', jsonb_strip_nulls(jsonb_build_object(
      'observation_count', v_observation_count,
      'compliant_count', v_compliant_count,
      'non_compliant_count', v_non_compliant_count,
      'breach_count', v_breach_count,
      'incident_count', case when not v_has_entity_scope then v_incident_count end,
      'checkpoint_visit_count', case when not v_has_entity_scope then v_checkpoint_count end
    )));
  end if;
  if array_position(v_sections, 'observations') is not null then
    v_data := v_data || jsonb_build_object('observations', v_observations);
  end if;
  if array_position(v_sections, 'breaches') is not null then
    v_data := v_data || jsonb_build_object('breaches', v_breaches);
  end if;
  if array_position(v_sections, 'incidents') is not null then
    v_data := v_data || jsonb_build_object('incidents', v_incidents);
  end if;
  if array_position(v_sections, 'checkpoint_visits') is not null then
    v_data := v_data || jsonb_build_object('checkpoint_visits', v_checkpoint_visits);
  end if;

  insert into public.monthly_report_packs (
    id, organization_id, service_agreement_id, template_code,
    period_start, period_end, status, report_kind, report_scope,
    data, editorial, generated_at, generated_by, updated_at
  ) values (
    v_pack_id,
    v_agreement.provider_organization_id,
    v_agreement.id,
    'custom_' || left(replace(v_pack_id::text, '-', ''), 24),
    p_period_start,
    p_period_end,
    'draft',
    'custom',
    v_report_scope,
    v_data,
    jsonb_build_object('title', btrim(p_title)),
    clock_timestamp(),
    v_actor,
    clock_timestamp()
  );

  insert into public.audit_log (
    organization_id, actor_user_id, action, target_table, target_id, metadata
  ) values (
    v_agreement.provider_organization_id,
    v_actor,
    'custom_report_pack_generated',
    'monthly_report_packs',
    v_pack_id,
    jsonb_build_object(
      'agreement_id', v_agreement.id,
      'period_start', p_period_start,
      'period_end', p_period_end,
      'sections', to_jsonb(v_sections),
      'site_count', cardinality(v_site_ids),
      'zone_count', cardinality(v_zone_ids),
      'person_count', cardinality(v_person_ids),
      'vehicle_count', cardinality(v_vehicle_ids),
      'observation_count', v_observation_count,
      'breach_count', v_breach_count,
      'status', 'draft'
    )
  );

  return jsonb_build_object(
    'id', v_pack_id,
    'status', 'draft',
    'observation_count', v_observation_count,
    'breach_count', v_breach_count,
    'incident_count', v_incident_count,
    'checkpoint_visit_count', v_checkpoint_count
  );
end;
$$;

comment on function public.generate_custom_report_pack(uuid, date, date, text, uuid[], uuid[], uuid[], uuid[], text[]) is
  'Creates a new provider-private custom report draft anchored to one accepted operational agreement. IDs are OR-matched within dimensions and AND-matched across populated dimensions; selected scope and source facts are snapshotted for review.';

revoke all on function public.generate_custom_report_pack(uuid, date, date, text, uuid[], uuid[], uuid[], uuid[], text[])
  from public, anon, authenticated, service_role;
grant execute on function public.generate_custom_report_pack(uuid, date, date, text, uuid[], uuid[], uuid[], uuid[], text[])
  to authenticated;