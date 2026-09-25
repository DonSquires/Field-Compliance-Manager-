-- Generated report data remains provider-private until a provider administrator
-- reviews and publishes it. Source-derived metrics stay separate from editable
-- client-facing editorial content.
alter table public.monthly_report_packs
  add column if not exists editorial jsonb not null default '{}'::jsonb,
  add column if not exists reviewed_at timestamptz,
  add column if not exists reviewed_by uuid,
  add column if not exists published_at timestamptz,
  add column if not exists published_by uuid,
  add column if not exists delivery_channel text;

alter table public.monthly_report_packs
  drop constraint if exists monthly_report_packs_editorial_check,
  add constraint monthly_report_packs_editorial_check check (
    jsonb_typeof(editorial) = 'object'
    and editorial - array['title', 'executive_summary', 'client_notes', 'follow_up']::text[] = '{}'::jsonb
  ),
  drop constraint if exists monthly_report_packs_delivery_channel_check,
  add constraint monthly_report_packs_delivery_channel_check
    check (delivery_channel is null or delivery_channel in ('portal', 'email')),
  drop constraint if exists monthly_report_packs_reviewed_by_fkey,
  add constraint monthly_report_packs_reviewed_by_fkey
    foreign key (reviewed_by) references public.user_profiles(id),
  drop constraint if exists monthly_report_packs_published_by_fkey,
  add constraint monthly_report_packs_published_by_fkey
    foreign key (published_by) references public.user_profiles(id);

comment on column public.monthly_report_packs.editorial is
  'Provider-authored client-facing title, summary, notes, and follow-up. Source-derived report data remains in data and is not manually editable.';
comment on column public.monthly_report_packs.reviewed_at is
  'When a provider administrator last saved the client-facing review.';
comment on column public.monthly_report_packs.reviewed_by is
  'Provider administrator who last saved the client-facing review.';
comment on column public.monthly_report_packs.published_at is
  'When the reviewed pack was explicitly released for client delivery.';
comment on column public.monthly_report_packs.published_by is
  'Provider administrator who explicitly released the reviewed pack.';
comment on column public.monthly_report_packs.delivery_channel is
  'portal when an active client login can consume live reporting; email otherwise.';

create index if not exists monthly_report_packs_client_published_idx
  on public.monthly_report_packs(service_agreement_id, period_end desc)
  where status in ('generated', 'sent');

drop policy if exists monthly_report_packs_select on public.monthly_report_packs;
create policy monthly_report_packs_select
on public.monthly_report_packs
for select
to authenticated
using (
  public.is_admin_for_org(organization_id)
  or exists (
    select 1
    from public.service_agreements agreement
    where agreement.id = monthly_report_packs.service_agreement_id
      and (
        monthly_report_packs.status in ('generated', 'sent')
        and agreement.client_portal_reports_enabled
        and public.org_access_allowed(agreement.client_organization_id)
      )
  )
);

-- Browser users read report packs and mutate them only through governed RPCs.
revoke insert, update, delete on table public.monthly_report_packs from anon, authenticated;
revoke select on table public.monthly_report_packs from anon;
grant select on table public.monthly_report_packs to authenticated;

create or replace function public.review_monthly_report_pack(
  p_pack_id uuid,
  p_expected_updated_at timestamptz,
  p_title text default null,
  p_executive_summary text default null,
  p_client_notes text default null,
  p_follow_up text default null,
  p_action text default 'save'
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_actor uuid := auth.uid();
  v_pack record;
  v_editorial jsonb;
  v_client_has_login boolean := false;
  v_delivery_channel text;
  v_updated public.monthly_report_packs%rowtype;
begin
  if v_actor is null then
    raise exception 'Authenticated provider administrator required';
  end if;
  if p_action not in ('save', 'publish') then
    raise exception 'Action must be save or publish';
  end if;
  if p_expected_updated_at is null then
    raise exception 'Expected updated timestamp is required';
  end if;
  if length(coalesce(p_title, '')) > 160
     or length(coalesce(p_executive_summary, '')) > 4000
     or length(coalesce(p_client_notes, '')) > 8000
     or length(coalesce(p_follow_up, '')) > 4000 then
    raise exception 'Report review content exceeds the allowed length';
  end if;

  select pack.*, agreement.client_organization_id,
         agreement.client_portal_reports_enabled
  into v_pack
  from public.monthly_report_packs pack
  join public.service_agreements agreement
    on agreement.id = pack.service_agreement_id
  where pack.id = p_pack_id
  for update of pack;

  if v_pack.id is null then
    raise exception 'Report pack not found';
  end if;
  if not public.is_admin_for_org(v_pack.organization_id) then
    raise exception 'Provider administrator access required';
  end if;
  if v_pack.status = 'sent' then
    raise exception 'Sent report packs are immutable';
  end if;
  if v_pack.updated_at is distinct from p_expected_updated_at then
    raise exception 'Report pack changed since it was opened; reload before saving';
  end if;

  v_editorial := jsonb_strip_nulls(jsonb_build_object(
    'title', nullif(btrim(coalesce(p_title, '')), ''),
    'executive_summary', nullif(btrim(coalesce(p_executive_summary, '')), ''),
    'client_notes', nullif(btrim(coalesce(p_client_notes, '')), ''),
    'follow_up', nullif(btrim(coalesce(p_follow_up, '')), '')
  ));

  if p_action = 'publish' and not (v_editorial ? 'title') then
    raise exception 'A client-facing report title is required before publishing';
  end if;

  select exists (
    select 1
    from public.user_profiles profile
    where profile.organization_id = v_pack.client_organization_id
      and profile.deactivated_at is null
      and profile.role in ('client_admin', 'client_officer', 'client_viewer')
  )
  into v_client_has_login;

  if p_action = 'publish' then
    v_delivery_channel := case
      when v_pack.client_portal_reports_enabled and v_client_has_login then 'portal'
      else 'email'
    end;
  end if;

  update public.monthly_report_packs
  set editorial = v_editorial,
      status = case when p_action = 'publish' then 'generated' else 'draft' end,
      reviewed_at = clock_timestamp(),
      reviewed_by = v_actor,
      published_at = case when p_action = 'publish' then clock_timestamp() else null end,
      published_by = case when p_action = 'publish' then v_actor else null end,
      delivery_channel = v_delivery_channel,
      pdf_path = null,
      pdf_mime_type = null,
      pdf_sha256 = null,
      pdf_renderer_version = null,
      delivery_error = null,
      updated_at = clock_timestamp()
  where id = p_pack_id
    and updated_at = p_expected_updated_at
  returning * into v_updated;

  if v_updated.id is null then
    raise exception 'Report pack changed since it was opened; reload before saving';
  end if;

  insert into public.audit_log (
    organization_id, actor_user_id, action, target_table, target_id, metadata
  ) values (
    v_updated.organization_id,
    v_actor,
    case when p_action = 'publish'
      then 'monthly_report_pack_published'
      else 'monthly_report_pack_review_saved'
    end,
    'monthly_report_packs',
    v_updated.id,
    jsonb_build_object(
      'status', v_updated.status,
      'delivery_channel', v_updated.delivery_channel,
      'client_has_login', v_client_has_login,
      'editorial_fields', array(select jsonb_object_keys(v_editorial))
    )
  );

  return jsonb_build_object(
    'id', v_updated.id,
    'status', v_updated.status,
    'editorial', v_updated.editorial,
    'updated_at', v_updated.updated_at,
    'reviewed_at', v_updated.reviewed_at,
    'published_at', v_updated.published_at,
    'delivery_channel', v_updated.delivery_channel,
    'client_has_login', v_client_has_login
  );
end;
$$;

comment on function public.review_monthly_report_pack(uuid, timestamptz, text, text, text, text, text) is
  'Saves or publishes provider-authored report editorial content with optimistic locking and audit evidence. Source-derived metrics are not editable; sent packs are immutable.';

revoke all on function public.review_monthly_report_pack(uuid, timestamptz, text, text, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.review_monthly_report_pack(uuid, timestamptz, text, text, text, text, text)
  to authenticated;

create or replace function public.generate_due_report_packs(
  p_period_start date,
  p_period_end date
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_actor uuid := auth.uid();
  v_provider uuid;
  v_agreement record;
  v_count integer := 0;
  v_written integer;
  v_data jsonb;
  v_start_ts timestamptz := p_period_start::timestamptz;
  v_end_ts timestamptz := p_period_end::timestamptz + interval '1 day';
  v_sla_met integer;
  v_sla_breached integer;
  v_sla_running integer;
  v_inc_total integer;
  v_inc_by_sev jsonb;
  v_checkpoints integer;
  v_breaches integer;
  v_delivery jsonb;
  v_facilities jsonb;
begin
  if p_period_start is null or p_period_end is null
     or p_period_start > p_period_end
     or p_period_end - p_period_start > 366 then
    raise exception 'Select a valid report period of 366 days or less';
  end if;

  select profile.organization_id
  into v_provider
  from public.user_profiles profile
  where profile.id = v_actor
    and profile.deactivated_at is null;

  if v_provider is null or not public.is_admin_for_org(v_provider) then
    raise exception 'Active provider administrator required';
  end if;

  for v_agreement in
    select agreement.id, agreement.provider_organization_id,
           agreement.monthly_report_template_code
    from public.service_agreements agreement
    where agreement.provider_organization_id = any(public.get_descendant_organizations(v_provider))
      and agreement.monthly_report_template_code is not null
  loop
    select count(*) filter (where clock.status = 'met'),
           count(*) filter (where clock.status = 'breached'),
           count(*) filter (where clock.status = 'running')
    into v_sla_met, v_sla_breached, v_sla_running
    from public.sla_clocks clock
    where clock.service_agreement_id = v_agreement.id
      and clock.started_at >= v_start_ts
      and clock.started_at < v_end_ts;

    select count(*), coalesce(jsonb_object_agg(summary.severity, summary.n), '{}'::jsonb)
    into v_inc_total, v_inc_by_sev
    from (
      select incident.severity, count(*) as n
      from public.incidents incident
      where incident.organization_id = v_agreement.provider_organization_id
        and incident.occurred_at >= v_start_ts
        and incident.occurred_at < v_end_ts
      group by incident.severity
    ) summary;

    select count(*) into v_checkpoints
    from public.patrol_checkpoint_visits visit
    where visit.organization_id = v_agreement.provider_organization_id
      and visit.visited_at >= v_start_ts
      and visit.visited_at < v_end_ts;

    select count(*) into v_breaches
    from public.breach_alerts alert
    where alert.organization_id = v_agreement.provider_organization_id
      and alert.created_at >= v_start_ts
      and alert.created_at < v_end_ts;

    v_delivery := public.agreement_service_delivery(
      v_agreement.id,
      p_period_start,
      p_period_end
    );

    select coalesce(jsonb_agg(jsonb_build_object(
      'siteName', place->>'place_name',
      'expected', (place->>'patrol_expected')::integer + (place->>'post_expected')::integer,
      'completed', (place->>'patrol_completed')::integer + (place->>'post_attended')::integer
    ) order by place->>'place_name'), '[]'::jsonb)
    into v_facilities
    from jsonb_array_elements(v_delivery->'places') as place;

    v_data := jsonb_build_object(
      'slaMet', coalesce(v_sla_met, 0),
      'slaBreached', coalesce(v_sla_breached, 0),
      'slaRunning', coalesce(v_sla_running, 0),
      'incidentsTotal', coalesce(v_inc_total, 0),
      'incidentsBySeverity', coalesce(v_inc_by_sev, '{}'::jsonb),
      'checkpointVisits', coalesce(v_checkpoints, 0),
      'breachAlerts', coalesce(v_breaches, 0),
      'facilities', v_facilities,
      'delivery', v_delivery
    );

    insert into public.monthly_report_packs as existing (
      organization_id, service_agreement_id, template_code, period_start,
      period_end, status, data, generated_at, generated_by, updated_at
    ) values (
      v_agreement.provider_organization_id,
      v_agreement.id,
      v_agreement.monthly_report_template_code,
      p_period_start,
      p_period_end,
      'draft',
      v_data,
      clock_timestamp(),
      v_actor,
      clock_timestamp()
    )
    on conflict (service_agreement_id, template_code, period_start)
    do update set
      data = excluded.data,
      status = 'draft',
      generated_at = clock_timestamp(),
      generated_by = v_actor,
      reviewed_at = null,
      reviewed_by = null,
      published_at = null,
      published_by = null,
      delivery_channel = null,
      pdf_path = null,
      pdf_mime_type = null,
      pdf_sha256 = null,
      pdf_renderer_version = null,
      delivery_error = null,
      updated_at = clock_timestamp()
    where existing.status <> 'sent';

    get diagnostics v_written = row_count;
    v_count := v_count + v_written;
  end loop;

  insert into public.audit_log (
    organization_id, actor_user_id, action, target_table, metadata
  ) values (
    v_provider,
    v_actor,
    'monthly_report_packs_generated',
    'monthly_report_packs',
    jsonb_build_object(
      'period_start', p_period_start,
      'period_end', p_period_end,
      'pack_count', v_count,
      'status', 'draft'
    )
  );

  return v_count;
end;
$$;

comment on function public.generate_due_report_packs(date, date) is
  'Assembles provider-private draft report packs for eligible provider-tree agreements. Sent packs are immutable; the result counts only inserted or refreshed drafts.';

revoke all on function public.generate_due_report_packs(date, date)
  from public, anon, authenticated, service_role;
grant execute on function public.generate_due_report_packs(date, date)
  to authenticated, service_role;
