-- A dispatch job the officer attended is part of what happened at the client's
-- place, so it belongs in the client report as a call-out, and in the officer
-- timeline (owner-reported gap 2026-11-04, Gibbons job
-- faa172a3-db67-4395-a4c8-64f899501d65 from website enquiry ENQ-024654).
--
-- Reconciled with 20261106120400_officer_records_report_ledger, which already
-- projects each completed job into location_events as one 'dispatch_callout'
-- row (source 'dispatch_job', external_ref = job id). That projection stays the
-- single ledger row per job, so nothing is counted twice. This migration:
--   * enriches the projection with what the client needs: when it was
--     requested, when the officer was on scene, the response time against the
--     SLA target, when it was completed, and the outcome notes;
--   * also projects a job cancelled after the officer was already on scene; a
--     call-out cancelled before anyone attended did not happen at the place;
--   * keeps the existing boundaries: staff-sensitive investigations and jobs
--     already reported through an incident are never projected, briefing notes,
--     the harmed party, officer identity and costs never enter the payload, and
--     free text reaches the client only through report_redact_identified_persons;
--   * refreshes rows already projected, so earlier call-outs read the same way;
--   * classifies dispatch_callout as its own client category, call_out, ranked
--     straight after incidents (it was previously other site work);
--   * lists each dispatch milestone on both officer activity timelines.

create or replace function public.project_dispatch_job_to_ledger(p_job_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_tz constant text := 'Pacific/Auckland';
  j public.dispatch_jobs%rowtype;
  v_clock_started timestamptz;
  v_clock_elapsed integer;
  v_clock_target integer;
  v_clock_status text;
  v_requested timestamptz;
  v_at timestamptz;
  v_day date;
  v_response integer;
  v_target integer;
  v_sla text;
  v_type text;
  v_issue text;
  v_action text;
  v_id uuid;
begin
  select * into j from public.dispatch_jobs where id = p_job_id;
  if not found or (j.client_site_id is null and j.zone_id is null) then
    return null;
  end if;
  if not (j.status = 'completed' or (j.status = 'cancelled' and j.on_scene_at is not null)) then
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

  select c.started_at, c.elapsed_minutes, c.target_minutes, c.status
    into v_clock_started, v_clock_elapsed, v_clock_target, v_clock_status
  from public.sla_clocks c
  where c.dispatch_job_id = j.id
  order by c.created_at desc nulls last
  limit 1;

  v_requested := coalesce(v_clock_started, j.created_at);
  v_at := coalesce(j.completed_at, j.on_scene_at, now());
  v_day := (v_at at time zone v_tz)::date;
  v_target := coalesce(v_clock_target, j.sla_minutes);
  if j.on_scene_at is not null then
    v_response := coalesce(v_clock_elapsed,
      greatest(0, ceil(extract(epoch from (j.on_scene_at - v_requested)) / 60.0))::integer);
    v_sla := case
      when v_clock_status in ('met', 'breached') then v_clock_status
      when v_target is null then null
      when v_response <= v_target then 'met'
      else 'breached'
    end;
  end if;

  v_type := case when j.job_type ~ '^[a-z0-9_]{1,40}$' then initcap(replace(j.job_type, '_', ' ')) else 'Call-out' end;
  v_issue := case when j.status = 'completed' then 'Call-out attended: ' else 'Call-out cancelled on scene: ' end
    || v_type
    || case when j.priority in ('high', 'urgent') then ' (' || j.priority || ' priority)' else '' end;

  v_action := concat_ws(', ',
    case when v_requested is not null then
      'Requested ' || case when (v_requested at time zone v_tz)::date = v_day
        then to_char(v_requested at time zone v_tz, 'HH24:MI')
        else to_char(v_requested at time zone v_tz, 'FMDD Mon HH24:MI') end
    end,
    case when j.on_scene_at is not null then
      'on scene ' || case when (j.on_scene_at at time zone v_tz)::date = v_day
        then to_char(j.on_scene_at at time zone v_tz, 'HH24:MI')
        else to_char(j.on_scene_at at time zone v_tz, 'FMDD Mon HH24:MI') end
      || ' (' || v_response || ' min response'
      || case when v_target is not null then
        '; ' || v_target || ' min target ' || case when v_sla = 'breached' then 'missed' else 'met' end
        else '' end
      || ')'
    end,
    case
      when j.status = 'completed' and j.completed_at is not null then
        'completed ' || to_char(j.completed_at at time zone v_tz, 'HH24:MI')
      when j.status = 'cancelled' then 'cancelled'
    end
  ) || '.'
  || case when v_sla = 'breached' and nullif(btrim(j.sla_delay_reason), '') is not null
    then ' Delay: ' || btrim(j.sla_delay_reason) else '' end;

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
    v_at,
    j.status,
    'dispatch_job',
    j.id::text,
    jsonb_strip_nulls(jsonb_build_object(
      'dispatch_job_id', j.id,
      'job_type', case when j.job_type ~ '^[a-z0-9_]{1,40}$' then j.job_type end,
      'priority', case when j.priority ~ '^[a-z0-9_]{1,20}$' then j.priority end,
      'job_status', j.status,
      'issue', v_issue,
      'comments', nullif(btrim(coalesce(j.outcome_notes, '')), ''),
      'action_notes', v_action,
      'requested_at', v_requested,
      'dispatched_at', j.dispatched_at,
      'on_scene_at', j.on_scene_at,
      'completed_at', j.completed_at,
      'response_minutes', v_response,
      'sla_target_minutes', v_target,
      'sla_status', v_sla
    ))
  )
  on conflict (organization_id, event_type, external_ref) where external_ref is not null
  do update set payload = excluded.payload, status = excluded.status, occurred_at = excluded.occurred_at
    where public.location_events.source = 'dispatch_job'
  returning id into v_id;
  return v_id;
end;
$function$;
comment on function public.project_dispatch_job_to_ledger(uuid) is
  'Internal: projects one completed dispatch callout, or one cancelled after the officer was on scene, into location_events as a dispatch_callout with the request, on-scene and completed times, response against the SLA target, and outcome notes only (never briefing notes, officer identity or costs). One row per job; re-projection refreshes it.';
REVOKE ALL ON FUNCTION public.project_dispatch_job_to_ledger(uuid) FROM PUBLIC, "anon", "authenticated", "service_role";
GRANT EXECUTE ON FUNCTION public.project_dispatch_job_to_ledger(uuid) TO "postgres";

drop trigger if exists trg_dispatch_jobs_project_to_ledger on public.dispatch_jobs;
create trigger trg_dispatch_jobs_project_to_ledger
  after insert or update of status, on_scene_at, completed_at, client_site_id, zone_id on public.dispatch_jobs
  for each row
  when (new.status = 'completed' or (new.status = 'cancelled' and new.on_scene_at is not null))
  execute function public.tg_project_dispatch_job_to_ledger();

-- Backfill: refresh call-outs already projected and add those cancelled on scene.
do $backfill$
begin
  perform public.project_dispatch_job_to_ledger(j.id)
  from public.dispatch_jobs j
  where j.status = 'completed' or (j.status = 'cancelled' and j.on_scene_at is not null)
  order by j.completed_at, j.id;
end;
$backfill$;

-- Report category: an attended call-out is client news, ranked straight after incidents.
create or replace function public.report_activity_category(p_kind text, p_event_type text, p_service_line text, p_subject text, p_activity text, p_species text, p_equipment text, p_material text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog'
AS $function$
	select case
		when p_kind = 'incident' then 'incident'
		when p_event_type = 'dispatch_callout' then 'call_out'
		when p_service_line = 'pest_control'
			or p_subject in ('animal', 'pest_device')
			or p_activity in ('cull', 'sighting', 'pest_patrol', 'device_unset', 'device_reset', 'device_inactive', 'rebait', 'prefeed')
			or p_species is not null
			or p_equipment in ('trap', 'bait_station')
			or p_material in ('ammunition', 'bait_feed')
			then 'pest_control'
		when p_activity = 'manufacture' then 'manufacture'
		when p_activity = 'maintenance' then 'maintenance'
		when p_activity in ('installation', 'uninstall', 'removal') then 'installation_removal'
		when p_activity = 'securing' then 'securing'
		when p_activity = 'inspection' then 'inspection'
		when p_activity in ('travel', 'administration', 'materials') then 'travel_admin'
		when p_kind = 'observation' then 'vehicle_observation'
		when p_event_type = 'camera_activation' then 'camera_activation'
		when p_activity = 'other' then 'other_work'
		when p_event_type = 'patrol_visit' then 'patrol_visit'
		else 'unclassified'
	end;
$function$;
COMMENT ON FUNCTION "public"."report_activity_category"(p_kind text, p_event_type text, p_service_line text, p_subject text, p_activity text, p_species text, p_equipment text, p_material text) IS 'Assigns exactly one report category to a recorded activity entry. Precedence: incidents, attended dispatch call-outs, pest control, manufacture, maintenance, installation and removal, securing, inspection, travel and administration, observations, camera activations, other recorded work, patrol visits without a work type, then other site activity.';
REVOKE ALL ON FUNCTION "public"."report_activity_category"(p_kind text, p_event_type text, p_service_line text, p_subject text, p_activity text, p_species text, p_equipment text, p_material text) FROM PUBLIC, "anon", "authenticated", "service_role";
GRANT EXECUTE ON FUNCTION "public"."report_activity_category"(p_kind text, p_event_type text, p_service_line text, p_subject text, p_activity text, p_species text, p_equipment text, p_material text) TO "postgres";

-- The client report counts and itemises call-outs. The body is otherwise the live definition.
create or replace function public.build_agreement_activity_report_core(p_service_agreement_id uuid, p_from timestamp with time zone, p_to timestamp with time zone, p_max_lines integer DEFAULT 2000)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
with
params as materialized (
	select greatest(0, least(coalesce(p_max_lines, 2000), 5000)) as max_lines
),
agreement as materialized (
	select a.provider_organization_id, a.client_organization_id
	from public.service_agreements a
	where a.id = p_service_agreement_id
),
links as materialized (
	select l.id as link_id, l.site_id, l.zone_id,
		coalesce(s.name, z.name, 'Unnamed place') as place_name
	from public.service_agreement_locations l
	left join public.client_sites s on s.id = l.site_id
	left join public.location_zones z on z.id = l.zone_id
	where l.service_agreement_id = p_service_agreement_id
		and l.status = 'active'
),
event_scope as materialized (
	select e.id, e.occurred_at, e.event_type, e.source, e.module_key, e.payload, e.observed_entity_id, pl.place_name
	from public.location_events e
	cross join lateral (
		select k.place_name
		from links k
		where (k.zone_id is not null and k.zone_id = e.zone_id)
			or (k.site_id is not null and k.site_id = e.client_site_id)
		order by k.place_name, k.link_id
		limit 1
	) pl
	where e.occurred_at >= p_from
		and e.occurred_at < p_to
),
observation_scope as materialized (
	select o.id, o.observed_at, o.module_key, o.officer_notes, o.officer_id,
		case when jsonb_typeof(o.external_refs -> 'import') = 'object' then o.external_refs -> 'import' else '{}'::jsonb end as imported,
		array_remove(array[
			nullif(btrim(o.watermarked_photo_url), ''),
			nullif(btrim(o.original_photo_url), ''),
			nullif(btrim(o.photo_url), '')
		], null) as direct_photo_paths,
		pl.place_name
	from public.observations o
	cross join lateral (
		select k.place_name
		from links k
		where (k.zone_id is not null and k.zone_id = o.zone_id)
			or (k.site_id is not null and k.site_id = o.site_id)
		order by k.place_name, k.link_id
		limit 1
	) pl
	where o.observed_at >= p_from
		and o.observed_at < p_to
),
work_order_scope as materialized (
	select w.id, w.kind, w.status, w.order_number, w.title, w.description, w.completion_note,
		coalesce(w.completed_at, w.started_at, w.scheduled_for, w.created_at) as at,
		public.report_code_or_null(subject.code) as subject,
		public.report_code_or_null(activity.code) as activity,
		pl.place_name
	from public.workshop_work_orders w
	join agreement a on a.provider_organization_id = w.organization_id
	left join public.reference_codes subject on subject.id = w.work_subject_code_id
		and subject.organization_id = a.provider_organization_id and subject.code_type = 'work_subject'
	left join public.reference_codes activity on activity.id = w.work_activity_code_id
		and activity.organization_id = a.provider_organization_id and activity.code_type = 'work_activity'
	left join lateral (
		select k.place_name
		from links k
		where (k.zone_id is not null and k.zone_id = w.zone_id)
			or (k.site_id is not null and k.site_id = w.client_site_id)
		order by k.place_name, k.link_id
		limit 1
	) pl on true
	where w.status in ('approved', 'in_progress', 'completed')
		and (w.service_agreement_id = p_service_agreement_id or pl.place_name is not null)
		and coalesce(w.completed_at, w.started_at, w.scheduled_for, w.created_at) >= p_from
		and coalesce(w.completed_at, w.started_at, w.scheduled_for, w.created_at) < p_to
),
incident_scope as materialized (
	select i.id, i.occurred_at, i.incident_type, i.severity, i.status, i.description, i.location_event_id,
		inv.investigation_reference, inv.status as investigation_status, pl.place_name
	from public.incidents i
	join agreement a on i.organization_id in (a.provider_organization_id, a.client_organization_id)
	cross join lateral (
		select k.place_name
		from links k
		where (k.zone_id is not null and k.zone_id = i.zone_id)
			or (k.site_id is not null and k.site_id = i.client_site_id)
		order by k.place_name, k.link_id
		limit 1
	) pl
	left join public.investigations inv on inv.id = i.investigation_id
		and inv.organization_id in (a.provider_organization_id, a.client_organization_id)
	where i.occurred_at >= p_from
		and i.occurred_at < p_to
		and not i.is_staff_sensitive
),
-- One row per stored photo per entry. Observation photo variants (watermarked,
-- original, captured) are one photo; evidence items carry no bucket column, so
-- they are read from bob-uploads unless they are an observation's own photo.
photo_refs as materialized (
	select distinct on (r.record_id, r.path) r.record_id, r.bucket, r.path, r.captured_at
	from (
		select i.location_event_id as record_id, 'bob-uploads'::text as bucket, i.storage_path as path, i.captured_at, 3 as priority
		from public.evidence_items i
		join event_scope e on e.id = i.location_event_id
		where i.evidence_kind = 'photo'
			and i.storage_path is not null
			and not public.report_photo_name_withheld(i.metadata ->> 'original_name')
		union all
		select o.id,
			case when s.storage_path = any(o.direct_photo_paths) then 'scans' else s.storage_bucket end,
			case when s.storage_path = any(o.direct_photo_paths) then o.direct_photo_paths[1] else s.storage_path end,
			s.captured_at, 1
		from public.observation_supporting_evidence s
		join observation_scope o on o.id = s.observation_id
		where s.evidence_kind = 'external_photo'
			and s.storage_path is not null
			and not public.report_photo_name_withheld(s.storage_path)
		union all
		select o.id,
			case when i.storage_path = any(o.direct_photo_paths) then 'scans' else 'bob-uploads' end,
			case when i.storage_path = any(o.direct_photo_paths) then o.direct_photo_paths[1] else i.storage_path end,
			i.captured_at, 3
		from public.evidence_items i
		join observation_scope o on o.id::text = i.metadata ->> 'observation_id'
		where i.evidence_kind = 'photo'
			and i.storage_path is not null
			and not public.report_photo_name_withheld(i.metadata ->> 'original_name')
		union all
		select o.id, 'scans', o.direct_photo_paths[1], o.observed_at, 2
		from observation_scope o
		where cardinality(o.direct_photo_paths) > 0
		union all
		select n.id, 'bob-uploads', i.storage_path, i.captured_at, 3
		from incident_scope n
		join public.incident_attachments a on a.incident_id = n.id and a.attachment_kind = 'photo'
		join public.evidence_items i on i.id = a.evidence_item_id
		where i.storage_path is not null
			and not public.report_photo_name_withheld(i.metadata ->> 'original_name')
		union all
		select n.id, 'bob-uploads', i.storage_path, i.captured_at, 3
		from incident_scope n
		join public.evidence_items i on i.location_event_id = n.location_event_id
		where i.evidence_kind = 'photo'
			and i.storage_path is not null
			and not public.report_photo_name_withheld(i.metadata ->> 'original_name')
	) r
	where not public.report_photo_name_withheld(r.path)
	order by r.record_id, r.path, r.priority
),
photo_ranked as (
	select r.record_id, r.bucket, r.path,
		r.path ~* '^[a-z][a-z0-9+.-]*://' as external_url,
		row_number() over (
			partition by r.record_id, r.path ~* '^[a-z][a-z0-9+.-]*://'
			order by r.captured_at, r.path
		) as rn
	from photo_refs r
),
photo_counts as (
	select p.record_id, count(*) as n,
		jsonb_agg(jsonb_build_object('b', p.bucket, 'p', p.path) order by p.rn)
			filter (where not p.external_url and p.rn <= 4) as refs
	from photo_ranked p
	group by p.record_id
),
incident_videos as (
	select a.incident_id as record_id, count(distinct coalesce(a.evidence_item_id, a.id)) as n
	from public.incident_attachments a
	join incident_scope n on n.id = a.incident_id
	where a.attachment_kind = 'video'
	group by a.incident_id
),
acts_base as materialized (
	select e.id as record_id, 'event'::text as kind, e.occurred_at as at, e.place_name, e.module_key,
		e.event_type,
		public.report_service_line(e.payload ->> 'source_category') as service_line,
		public.report_code_or_null(e.payload ->> 'work_subject_code') as subject,
		public.report_code_or_null(e.payload ->> 'work_activity_code') as activity,
		public.report_code_or_null(e.payload ->> 'biosecurity_species_code') as species,
		public.report_code_or_null(e.payload ->> 'equipment_type_code') as equipment,
		public.report_code_or_null(e.payload ->> 'material_type_code') as material,
		case when e.payload ->> 'job_number' ~ '^[A-Za-z0-9._/-]{1,24}$' then e.payload ->> 'job_number' end as job,
		case when jsonb_typeof(e.payload -> 'materials_used') = 'array' then e.payload -> 'materials_used' else '[]'::jsonb end as materials,
		null::text as work_order_status,
		public.report_text_or_null(e.payload ->> 'issue', 80) as title,
		public.report_text_or_null(e.payload ->> 'comments', 1500) as note,
		public.report_text_or_null(e.payload ->> 'action_notes', 1500) as action,
		null::text as incident_type,
		null::text as severity,
		null::text as incident_status,
		null::text as investigation_ref,
		null::text as investigation_status
	from event_scope e
	where e.source is distinct from 'observation_trigger'
	union all
	select o.id, 'observation', o.observed_at, o.place_name, o.module_key,
		null::text,
		public.report_service_line(o.imported ->> 'source_category'),
		public.report_code_or_null(o.imported ->> 'work_subject_code'),
		public.report_code_or_null(o.imported ->> 'work_activity_code'),
		public.report_code_or_null(o.imported ->> 'biosecurity_species_code'),
		public.report_code_or_null(o.imported ->> 'equipment_type_code'),
		public.report_code_or_null(o.imported ->> 'material_type_code'),
		case when o.imported ->> 'job_number' ~ '^[A-Za-z0-9._/-]{1,24}$' then o.imported ->> 'job_number' end,
		case when jsonb_typeof(o.imported -> 'materials_used') = 'array' then o.imported -> 'materials_used' else '[]'::jsonb end,
		null::text,
		public.report_text_or_null(o.imported ->> 'issue', 80),
		coalesce(public.report_text_or_null(o.officer_notes, 1500), public.report_text_or_null(o.imported ->> 'comments', 1500)),
		public.report_text_or_null(o.imported ->> 'action_notes', 1500),
		null::text, null::text, null::text, null::text, null::text
	from observation_scope o
	union all
	select w.id, 'work_order', w.at, w.place_name, 'workshop',
		null::text,
		null::text,
		w.subject,
		coalesce(w.activity, case w.kind when 'maintenance' then 'maintenance' when 'fabrication' then 'manufacture' end),
		null::text,
		null::text,
		null::text,
		case when w.order_number ~ '^[A-Za-z0-9._/-]{1,24}$' then w.order_number end,
		'[]'::jsonb,
		w.status,
		public.report_text_or_null(w.title, 120),
		public.report_text_or_null(w.description, 1500),
		public.report_text_or_null(w.completion_note, 1500),
		null::text, null::text, null::text, null::text, null::text
	from work_order_scope w
	union all
	select n.id, 'incident', n.occurred_at, n.place_name, 'incident',
		null::text, null::text, null::text, null::text, null::text, null::text, null::text,
		null::text,
		'[]'::jsonb,
		null::text,
		null::text,
		public.report_text_or_null(n.description, 1500),
		null::text,
		public.report_code_or_null(n.incident_type),
		public.report_code_or_null(n.severity),
		public.report_code_or_null(n.status),
		case when n.investigation_reference ~ '^[A-Za-z0-9._/-]{1,32}$' then n.investigation_reference end,
		public.report_code_or_null(n.investigation_status)
	from incident_scope n
),
mats as (
	select a.record_id,
		public.report_code_or_null(m ->> 'material_type') as material_type,
		case
			when m ->> 'calibre' ~* '^(\.[0-9]{2,3}|[0-9]{1,2}(\.[0-9]{1,2})?mm)$' then lower(m ->> 'calibre')
			when m ? 'calibre' then 'unspecified'
		end as calibre,
		public.report_numeric_or_null(m ->> 'quantity') as quantity
	from acts_base a
	cross join lateral jsonb_array_elements(a.materials) m
	where jsonb_typeof(m) = 'object'
		and public.report_code_or_null(m ->> 'material_type') is not null
),
mat_lines as (
	select m.record_id,
		jsonb_agg(jsonb_strip_nulls(jsonb_build_object('t', m.material_type, 'cal', m.calibre, 'q', m.quantity))
			order by m.material_type, m.calibre, m.quantity) as materials
	from mats m
	group by m.record_id
),
acts as materialized (
	select a.record_id, a.kind, a.at, (a.at at time zone 'Pacific/Auckland')::date as local_date,
		to_char(a.at at time zone 'Pacific/Auckland', 'HH24:MI') as local_time,
		a.place_name, a.module_key, a.event_type, a.service_line, a.subject, a.activity, a.species,
		a.equipment, a.material, a.job, a.work_order_status, a.title, a.note, a.action,
		a.incident_type, a.severity, a.incident_status, a.investigation_ref, a.investigation_status,
		coalesce(pc.n, 0)::integer as photos, pc.refs as photo_refs, coalesce(iv.n, 0)::integer as videos,
		ml.materials as materials_used,
		c.category,
		-- Travel, materials and shift or movement markers are how the work was run,
		-- not what happened at the place, so the client report withholds them.
		-- Administration and desk entries are withheld too (owner ruling 2026-11-05,
		-- replacing the 2026-11-04 ruling that reported them). Photos and
		-- service-line classifications do not override this boundary.
		case
			when c.category = 'administration' then 'travel_admin'
			when a.activity in ('travel', 'administration', 'materials')
				or c.category = 'travel_admin' then 'travel_admin'
			when c.category in ('patrol_visit', 'other_work', 'unclassified')
				and regexp_replace(lower(coalesce(a.title, '')), '[^a-z]', '', 'g') in ('travel', 'admin', 'administration')
				then 'travel_admin'
			when c.category in ('patrol_visit', 'other_work', 'unclassified')
				and regexp_replace(lower(coalesce(a.note, '')), '[^a-z]', '', 'g') in (
					'start', 'finish', 'restart', 'home', 'enter', 'exit',
					'startshift', 'finishshift', 'endshift', 'shiftstart', 'shiftend', 'shiftfinish', 'endofshift'
				)
				then 'shift_marker'
			-- A card swap with nothing found is routine camera upkeep, not news for the client.
			when a.kind in ('event', 'observation')
				and coalesce(pc.n, 0) = 0
				and c.category <> 'incident'
				and regexp_replace(lower(coalesce(a.title, '')), '[^a-z]', '', 'g') in ('', 'card', 'cardreview', 'cardreplace', 'cardreplacement', 'cardchange', 'cardswap', 'replacecard')
				and btrim(regexp_replace(lower(concat_ws(' ', a.note, a.action)), '[^a-z]+', ' ', 'g')) ~ '^((sd )?cards? (replaced|replace|swapped|swap|changed|change)|(replaced|replace|swapped|swap|changed|change|new) (sd )?cards?)( (replaced|swapped|changed))?$'
				then 'routine_card'
			-- The same entry recorded twice: same local minute, place, officer, title, comment and action.
			when a.kind in ('event', 'observation')
				and row_number() over (
					partition by a.kind in ('event', 'observation'),
						date_trunc('minute', a.at at time zone 'Pacific/Auckland'),
						lower(coalesce(a.place_name, '')),
						coalesce(lower(btrim(coalesce(es.payload ->> 'patroller_raw', os.imported ->> 'patroller_raw'))), es.observed_entity_id::text, os.officer_id::text, ''),
						lower(btrim(regexp_replace(coalesce(a.title, ''), '\s+', ' ', 'g'))),
						lower(btrim(regexp_replace(coalesce(a.note, ''), '\s+', ' ', 'g'))),
						lower(btrim(regexp_replace(coalesce(a.action, ''), '\s+', ' ', 'g')))
					order by coalesce(pc.n, 0) desc, a.at, a.record_id::text
				) > 1
				then 'duplicate'
		end as withheld_reason
	from acts_base a
	left join mat_lines ml on ml.record_id = a.record_id
	left join photo_counts pc on pc.record_id = a.record_id
	left join incident_videos iv on iv.record_id = a.record_id
	left join event_scope es on a.kind = 'event' and es.id = a.record_id
	left join observation_scope os on a.kind = 'observation' and os.id = a.record_id
	cross join lateral (
		select case
			-- Camera card reviews are logged under the reviewing officer, so they arrive as
			-- patrol visits. Every card review is a camera observation for the client
			-- (owner ruling 2026-11-05), whatever its comment says and at any time of day.
			when a.kind = 'event'
				and regexp_replace(lower(coalesce(a.title, '')), '[^a-z]', '', 'g') = 'cardreview'
				then 'camera_activation'
			-- Travel stays operational even when it is logged as a desk entry.
			when a.activity in ('travel', 'materials')
				or regexp_replace(lower(coalesce(a.title, '')), '[^a-z]', '', 'g') = 'travel'
				then public.report_activity_category(a.kind, a.event_type, a.service_line, a.subject, a.activity, a.species, a.equipment, a.material)
			-- R&M patrol logs record desk work (card reviews, log entry, reconciliations)
			-- with a 0000 time, which imports as local midnight.
			when a.activity = 'administration'
				or regexp_replace(lower(coalesce(a.title, '')), '[^a-z]', '', 'g') in ('admin', 'administration')
				or (es.payload ->> 'source' = 'rm_patrol_log_import'
					and (a.at at time zone 'Pacific/Auckland')::time = time '00:00')
				then 'administration'
			else public.report_activity_category(a.kind, a.event_type, a.service_line, a.subject, a.activity, a.species, a.equipment, a.material)
		end as category
	) c
),
vis as materialized (
	select * from acts where withheld_reason is null
),
category_catalog(code, label, sort_order) as (
	values
		('incident', 'Incidents and investigations', 0),
		('call_out', 'Call-outs and responses', 1),
		('pest_control', 'Pest control', 2),
		('maintenance', 'Maintenance and repairs', 3),
		('manufacture', 'Manufacture and fabrication', 4),
		('installation_removal', 'Installation and removal', 5),
		('securing', 'Securing and access control', 6),
		('inspection', 'Inspections and checks', 7),
		('camera_activation', 'CCTV and camera activity', 8),
		('vehicle_observation', 'Observations', 9),
		('other_work', 'Other site work', 10),
		('administration', 'Administration and review', 11),
		('patrol_visit', 'Patrols', 12),
		('unclassified', 'Other site activity', 13),
		('travel_admin', 'Travel and materials', 14)
),
labels as (
	select rc.code_type, rc.code, rc.name
	from public.reference_codes rc
	where rc.code_type in ('work_activity', 'work_subject', 'biosecurity_species', 'equipment_type', 'material_type')
		and rc.is_active
		and rc.organization_id = (select provider_organization_id from agreement)
),
used_codes as (
	select 'activity' as dim, activity as code from vis where activity is not null
	union
	select 'subject', subject from vis where subject is not null
	union
	select 'species', species from vis where species is not null
	union
	select 'equipment', equipment from vis where equipment is not null
	union
	select 'material', material from vis where material is not null
	union
	select 'material', m.material_type from mats m join vis v on v.record_id = m.record_id
),
code_labels as (
	select u.dim, u.code,
		coalesce(l.name, initcap(replace(u.code, '_', ' '))) as label
	from used_codes u
	left join labels l
		on l.code = u.code
		and l.code_type = case u.dim
			when 'activity' then 'work_activity'
			when 'subject' then 'work_subject'
			when 'species' then 'biosecurity_species'
			when 'equipment' then 'equipment_type'
			else 'material_type'
		end
),
totals as (
	select count(*) as entries,
		count(*) filter (where kind = 'event') as events,
		count(*) filter (where kind = 'observation') as observations,
		count(*) filter (where kind = 'work_order') as work_orders,
		count(*) filter (where kind = 'incident') as incidents,
		count(*) filter (where category = 'call_out') as call_outs,
		count(*) filter (where kind = 'event' and event_type = 'patrol_visit' and category <> 'camera_activation') as patrol_visits,
		count(*) filter (where category = 'camera_activation') as camera_activations,
		count(*) filter (where note is not null or action is not null) as with_notes,
		count(distinct place_name) as places,
		(select count(distinct r.path) from photo_refs r join vis v on v.record_id = r.record_id) as photos
	from vis
),
category_totals as (
	select category, count(*) as entries, coalesce(sum(photos), 0) as photos
	from vis
	group by category
),
place_totals as (
	select coalesce(place_name, 'Not location-specific') as place_name, count(*) as entries,
		coalesce(sum(photos), 0) as photos
	from vis
	group by 1
),
place_categories as (
	select coalesce(place_name, 'Not location-specific') as place_name, category, count(*) as n
	from vis
	group by 1, 2
),
pest as (
	select * from vis where category = 'pest_control'
),
pest_species as (
	select coalesce(species, 'unspecified') as code,
		count(*) filter (where activity = 'cull') as culls,
		count(*) filter (where activity = 'sighting') as sightings,
		count(*) as total
	from pest
	where species is not null or activity in ('cull', 'sighting')
	group by 1
),
pest_activity as (
	select coalesce(activity, 'not_recorded') as code, count(*) as entries
	from pest
	group by 1
),
pest_equipment as (
	select equipment as code, count(*) as entries
	from pest
	where equipment is not null
	group by 1
),
pest_ammunition as (
	select coalesce(m.calibre, 'unspecified') as calibre, count(distinct m.record_id) as entries, sum(m.quantity) as rounds
	from mats m
	join pest p on p.record_id = m.record_id
	where m.material_type = 'ammunition'
	group by 1
),
work_subjects as (
	select category, coalesce(subject, 'not_recorded') as code, count(*) as entries
	from vis
	where category in ('maintenance', 'manufacture')
	group by category, coalesce(subject, 'not_recorded')
),
work_order_status as (
	select category,
		count(*) filter (where work_order_status = 'completed') as completed,
		count(*) filter (where work_order_status in ('approved', 'in_progress')) as open
	from vis
	where kind = 'work_order'
	group by category
),
observation_modules as (
	select coalesce(module_key, 'unknown') as module_key, count(*) as entries,
		count(*) filter (where photos > 0) as with_photo, coalesce(sum(photos), 0) as photos
	from vis
	where kind = 'observation'
	group by 1
),
incident_summary as (
	select count(*) as total,
		count(distinct investigation_ref) as investigations,
		count(*) filter (where photos > 0 or videos > 0) as with_media
	from vis
	where kind = 'incident'
),
numbered as (
	select row_number() over (order by v.at, v.place_name, v.category, v.record_id) as n, v.*
	from vis v
),
all_line_rows as (
	select n.n, jsonb_strip_nulls(jsonb_build_object(
		'd', n.local_date,
		't', n.local_time,
		'p', n.place_name,
		'k', n.kind,
		'c', n.category,
		'mo', case when n.kind = 'observation' then public.report_code_or_null(n.module_key) end,
		'a', n.activity,
		's', n.subject,
		'sp', n.species,
		'eq', n.equipment,
		'j', n.job,
		'm', n.materials_used,
		'ws', n.work_order_status,
		'ti', public.report_redact_identified_persons(n.title),
		'n', public.report_redact_identified_persons(n.note),
		'ac', public.report_redact_identified_persons(n.action),
		'it', n.incident_type,
		'sev', n.severity,
		'st', n.incident_status,
		'inv', n.investigation_ref,
		'ivs', n.investigation_status,
		'ph', nullif(n.photos, 0),
		'pr', n.photo_refs,
		'vid', nullif(n.videos, 0)
	)) as line
	from numbered n
),
line_rows as (
	select * from all_line_rows where n <= (select max_lines from params)
),
scope_counts as (
	select
		(select count(*) from event_scope) as events_in_scope,
		(select count(*) from event_scope where source = 'observation_trigger') as mirrors,
		(select count(*) from observation_scope) as observations_in_scope,
		(select count(*) from work_order_scope) as work_orders_in_scope,
		(select count(*) from incident_scope) as incidents_in_scope,
		(select count(*) from acts) as all_entries,
		(select count(*) filter (where withheld_reason = 'travel_admin') from acts) as withheld_travel_admin,
		(select count(*) filter (where withheld_reason = 'shift_marker') from acts) as withheld_shift_markers,
		(select count(*) filter (where withheld_reason = 'routine_card') from acts) as withheld_routine_cards,
		(select count(*) filter (where withheld_reason = 'duplicate') from acts) as withheld_duplicates
)
select jsonb_build_object(
	'report', jsonb_build_object(
		'version', 2,
		'itemisedDigest', (select md5(coalesce(string_agg(md5(lr.line::text), '' order by lr.n), '')) from all_line_rows lr),
		'basis', 'Activity recorded at the locations covered by this agreement: call-outs attended, patrols and site checks, observations, pest control, maintenance and manufacture, CCTV and incidents. Counts are recorded entries, not animals or devices.',
		'totals', (select jsonb_build_object(
			'entries', t.entries,
			'events', t.events,
			'observations', t.observations,
			'workOrders', t.work_orders,
			'incidents', t.incidents,
			'callOuts', t.call_outs,
			'patrolVisits', t.patrol_visits,
			'cameraActivations', t.camera_activations,
			'withNotes', t.with_notes,
			'places', t.places,
			'photos', t.photos
		) from totals t),
		'categories', coalesce((
			select jsonb_agg(jsonb_build_object('code', c.category, 'entries', c.entries, 'photos', c.photos)
				order by cc.sort_order)
			from category_totals c
			join category_catalog cc on cc.code = c.category
		), '[]'::jsonb),
		'byPlace', coalesce((
			select jsonb_agg(jsonb_build_object(
				'place', p.place_name, 'entries', p.entries, 'photos', p.photos,
				'categories', (
					select jsonb_object_agg(pc.category, pc.n)
					from place_categories pc
					where pc.place_name = p.place_name
				)
			) order by p.entries desc, p.place_name)
			from place_totals p
		), '[]'::jsonb),
		'pestControl', jsonb_build_object(
			'entries', (select count(*) from pest),
			'bySpecies', coalesce((
				select jsonb_agg(jsonb_build_object(
					'code', s.code, 'culls', s.culls, 'sightings', s.sightings,
					'other', s.total - s.culls - s.sightings, 'total', s.total
				) order by s.total desc, s.code)
				from pest_species s
			), '[]'::jsonb),
			'byActivity', coalesce((
				select jsonb_agg(jsonb_build_object('code', a.code, 'entries', a.entries)
					order by a.entries desc, a.code)
				from pest_activity a
			), '[]'::jsonb),
			'byEquipment', coalesce((
				select jsonb_agg(jsonb_build_object('code', q.code, 'entries', q.entries)
					order by q.entries desc, q.code)
				from pest_equipment q
			), '[]'::jsonb),
			'ammunition', coalesce((
				select jsonb_agg(jsonb_build_object(
					'calibre', m.calibre, 'entries', m.entries, 'rounds', m.rounds
				) order by m.entries desc, m.calibre)
				from pest_ammunition m
			), '[]'::jsonb)
		),
		'maintenance', jsonb_build_object(
			'entries', (select count(*) from vis where category = 'maintenance'),
			'bySubject', coalesce((
				select jsonb_agg(jsonb_build_object('code', w.code, 'entries', w.entries)
					order by w.entries desc, w.code)
				from work_subjects w
				where w.category = 'maintenance'
			), '[]'::jsonb),
			'workOrders', jsonb_build_object(
				'completed', coalesce((select completed from work_order_status where category = 'maintenance'), 0),
				'open', coalesce((select open from work_order_status where category = 'maintenance'), 0)
			)
		),
		'manufacture', jsonb_build_object(
			'entries', (select count(*) from vis where category = 'manufacture'),
			'bySubject', coalesce((
				select jsonb_agg(jsonb_build_object('code', w.code, 'entries', w.entries)
					order by w.entries desc, w.code)
				from work_subjects w
				where w.category = 'manufacture'
			), '[]'::jsonb),
			'workOrders', jsonb_build_object(
				'completed', coalesce((select completed from work_order_status where category = 'manufacture'), 0),
				'open', coalesce((select open from work_order_status where category = 'manufacture'), 0)
			)
		),
		'observations', jsonb_build_object(
			'total', (select count(*) from vis where kind = 'observation'),
			'withPhoto', (select count(*) from vis where kind = 'observation' and photos > 0),
			'photos', (select count(distinct r.path) from photo_refs r join vis v on v.record_id = r.record_id and v.kind = 'observation'),
			'byModule', coalesce((
				select jsonb_agg(jsonb_build_object(
					'module', m.module_key, 'entries', m.entries,
					'withPhoto', m.with_photo, 'photos', m.photos
				) order by m.entries desc, m.module_key)
				from observation_modules m
			), '[]'::jsonb)
		),
		'incidents', (select jsonb_build_object(
			'total', s.total,
			'investigations', s.investigations,
			'withMedia', s.with_media,
			'bySeverity', coalesce((
				select jsonb_agg(jsonb_build_object('code', x.code, 'entries', x.n) order by x.n desc, x.code)
				from (select coalesce(severity, 'standard') as code, count(*) as n from vis where kind = 'incident' group by 1) x
			), '[]'::jsonb),
			'byStatus', coalesce((
				select jsonb_agg(jsonb_build_object('code', x.code, 'entries', x.n) order by x.n desc, x.code)
				from (select coalesce(incident_status, 'open') as code, count(*) as n from vis where kind = 'incident' group by 1) x
			), '[]'::jsonb)
		) from incident_summary s),
		'labels', jsonb_build_object(
			'category', coalesce((select jsonb_object_agg(cc.code, cc.label) from category_catalog cc where cc.code in (select category from category_totals)), '{}'::jsonb),
			'activity', coalesce((select jsonb_object_agg(l.code, l.label) from code_labels l where l.dim = 'activity'), '{}'::jsonb),
			'subject', coalesce((select jsonb_object_agg(l.code, l.label) from code_labels l where l.dim = 'subject'), '{}'::jsonb),
			'species', coalesce((select jsonb_object_agg(l.code, l.label) from code_labels l where l.dim = 'species'), '{}'::jsonb),
			'equipment', coalesce((select jsonb_object_agg(l.code, l.label) from code_labels l where l.dim = 'equipment'), '{}'::jsonb),
			'material', coalesce((select jsonb_object_agg(l.code, l.label) from code_labels l where l.dim = 'material'), '{}'::jsonb)
		),
		'accountedFor', (select jsonb_build_object(
			'eventsInScope', sc.events_in_scope,
			'mirrorEventsExcluded', sc.mirrors,
			'activityEvents', sc.events_in_scope - sc.mirrors,
			'observationsInScope', sc.observations_in_scope,
			'workOrdersInScope', sc.work_orders_in_scope,
			'incidentsInScope', sc.incidents_in_scope,
			'entries', sc.all_entries,
			'reported', t.entries,
			'operationalWithheld', sc.withheld_travel_admin + sc.withheld_shift_markers + sc.withheld_routine_cards + sc.withheld_duplicates,
			'withheldTravelAdmin', sc.withheld_travel_admin,
			'withheldShiftMarkers', sc.withheld_shift_markers,
			'withheldRoutineCards', sc.withheld_routine_cards,
			'withheldDuplicates', sc.withheld_duplicates,
			'itemised', (select count(*) from line_rows),
			'notItemised', t.entries - (select count(*) from line_rows),
			'unclassified', coalesce((select ct.entries from category_totals ct where ct.category = 'unclassified'), 0),
			'reconciled', (
				sc.all_entries = (sc.events_in_scope - sc.mirrors) + sc.observations_in_scope + sc.work_orders_in_scope + sc.incidents_in_scope
				and sc.all_entries = t.entries + sc.withheld_travel_admin + sc.withheld_shift_markers + sc.withheld_routine_cards + sc.withheld_duplicates
				and t.entries = (select coalesce(sum(ct.entries), 0) from category_totals ct)
				and t.entries = (select coalesce(sum(pt.entries), 0) from place_totals pt)
			)
		) from scope_counts sc, totals t)
	),
	'lines', jsonb_build_object(
		'version', 2,
		'lines', coalesce((select jsonb_agg(lr.line order by lr.n) from line_rows lr), '[]'::jsonb),
		'notItemised', (select t.entries from totals t) - (select count(*) from line_rows)
	)
);
$function$;
COMMENT ON FUNCTION "public"."build_agreement_activity_report_core"(p_service_agreement_id uuid, p_from timestamp with time zone, p_to timestamp with time zone, p_max_lines integer) IS 'Internal assembler for the R&M month-end site activity report: what happened at one agreement''s places in a window, as categorised statistics and itemised entries with the comments, action notes, incident descriptions and photos recorded there. Travel, materials and shift or movement markers are withheld from the client report but accounted for, and so is administration (including 0000 desk entries in R&M patrol logs). Every camera card review is reported as a camera observation, except a photo-less card replacement, which is withheld as routine; an entry repeated with the same local minute, place, officer, title, comment and action is withheld as a duplicate. Attended dispatch call-outs are reported in their own category with when they were requested, when the officer was on scene, the response time against the target and the outcome. Observation mirror events are excluded so nothing is counted twice. Personal details of identified people in titles, comments and action notes are replaced with "R & M have identified a person relating to this", and NZTA screenshots and identity-document photos are never included. Never copied: costs, officer or staff names, structured plates, GPS, investigation detail or source file names. Auth is on generate_due_report_packs and get_report_pack_activity_accounting.';
REVOKE ALL ON FUNCTION "public"."build_agreement_activity_report_core"(p_service_agreement_id uuid, p_from timestamp with time zone, p_to timestamp with time zone, p_max_lines integer) FROM PUBLIC, "anon", "authenticated", "service_role";
GRANT EXECUTE ON FUNCTION "public"."build_agreement_activity_report_core"(p_service_agreement_id uuid, p_from timestamp with time zone, p_to timestamp with time zone, p_max_lines integer) TO "postgres";

-- The officer timeline (and its evidence export) shows each dispatch milestone the officer recorded.
create or replace function public.get_officer_activity_timeline(p_officer_id uuid, p_from timestamp with time zone, p_to timestamp with time zone, p_limit integer DEFAULT 1000)
 RETURNS TABLE(event_key text, event_type text, event_at timestamp with time zone, received_at timestamp with time zone, source_table text, source_id uuid, gps_lat double precision, gps_lng double precision, shift_id uuid, site_id uuid, zone_id uuid, summary text, details jsonb)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_org_id uuid;
begin
  select organization_id into v_org_id from public.user_profiles where id = p_officer_id;
  if v_org_id is null then return; end if;
  if auth.uid() <> p_officer_id and not public.is_admin_for_org(v_org_id) then raise exception 'Not authorised to view this officer timeline'; end if;
  if p_from is null or p_to is null or p_from >= p_to or p_to - p_from > interval '31 days' then raise exception 'Timeline range must be between 1 second and 31 days'; end if;

  return query
  with events as (
    select 'gps:' || g.id::text, 'gps_' || g.activity_type, g.recorded_at, g.created_at,
      'officer_gps_log'::text, g.id, g.gps_lat, g.gps_lng, g.shift_id, null::uuid, g.detected_zone_id,
      case when g.activity_type = 'gps_update' then 'GPS heartbeat' else replace(g.activity_type, '_', ' ') end,
      jsonb_build_object('accuracy_meters', g.accuracy_meters, 'heading', g.heading, 'speed_kmh', g.speed_kmh, 'client_event_id', g.client_event_id)
    from public.officer_gps_log g
    where g.organization_id = v_org_id and g.officer_id = p_officer_id and g.recorded_at between p_from and p_to

    union all
    select 'welfare_check:' || w.id::text, 'welfare_check', w.checked_in_at, w.checked_in_at,
      'welfare_checks', w.id, w.gps_lat, w.gps_lng, w.shift_id, null::uuid, null::uuid,
      'Welfare check-in: ' || w.status, jsonb_build_object('status', w.status, 'notes', w.notes)
    from public.welfare_checks w where w.organization_id = v_org_id and w.officer_user_id = p_officer_id and w.checked_in_at between p_from and p_to

    union all
    select 'observation:' || o.id::text, 'observation', o.observed_at, o.created_at,
      'observations', o.id, o.gps_lat, o.gps_lng, null::uuid, o.site_id, o.zone_id,
      'Vehicle observation ' || o.plate_number, jsonb_build_object('module_key', o.module_key, 'compliance_status', o.compliance_status, 'plate_number', o.plate_number)
    from public.observations o where o.organization_id = v_org_id and o.officer_id = p_officer_id and o.observed_at between p_from and p_to

    union all
    select 'checkpoint:' || v.id::text, 'checkpoint_visit', v.visited_at, v.visited_at,
      'patrol_checkpoint_visits', v.id, v.gps_lat, v.gps_lng, p.shift_id, null::uuid, null::uuid,
      'Patrol checkpoint visit', jsonb_build_object('checkpoint_id', v.checkpoint_id, 'scan_method', v.scan_method, 'within_radius', v.within_radius, 'notes', v.notes)
    from public.patrol_checkpoint_visits v join public.patrols p on p.id = v.patrol_id
    where v.organization_id = v_org_id and v.officer_user_id = p_officer_id and v.visited_at between p_from and p_to

    union all
    select 'report:' || r.id::text, 'field_report', r.reported_at, r.created_at,
      'officer_field_reports', r.id, r.gps_lat, r.gps_lng, r.shift_id, r.site_id, r.zone_id,
      r.title, jsonb_build_object('report_type', r.report_type, 'severity', r.severity, 'status', r.status, 'immediate_action', r.immediate_action)
    from public.officer_field_reports r where r.organization_id = v_org_id and r.officer_id = p_officer_id and r.reported_at between p_from and p_to

    union all
    select 'stop_action:' || a.id::text, 'shift_stop_action', a.performed_at, a.created_at,
      'shift_stop_actions', a.id, a.gps_lat, a.gps_lng, a.shift_id, null::uuid, null::uuid,
      replace(a.action_type, '_', ' '), jsonb_build_object('outcome', a.outcome, 'notes', a.notes, 'result_table', a.result_table, 'result_record_id', a.result_record_id)
    from public.shift_stop_actions a join public.shifts s on s.id = a.shift_id
    where a.organization_id = v_org_id and s.officer_user_id = p_officer_id and a.performed_at between p_from and p_to

    union all
    select 'dispatch_job:' || j.id::text || ':' || m.milestone, 'dispatch_' || m.milestone, m.at, m.at,
      'dispatch_jobs', j.id, null::double precision, null::double precision, j.shift_id, j.client_site_id, j.zone_id,
      initcap(replace(j.job_type, '_', ' ')) || ' call-out ' || m.label,
      jsonb_build_object('job_type', j.job_type, 'priority', j.priority, 'status', j.status, 'sla_minutes', j.sla_minutes, 'sla_breached', j.sla_breached)
        || case when m.milestone = 'completed' then jsonb_build_object('outcome_notes', j.outcome_notes) else '{}'::jsonb end
    from public.dispatch_jobs j
    cross join lateral (values ('dispatched', 'dispatched', j.dispatched_at), ('acknowledged', 'acknowledged', j.acknowledged_at),
      ('en_route', 'en route', j.en_route_at), ('on_scene', 'on scene', j.on_scene_at), ('completed', 'completed', j.completed_at)) m(milestone, label, at)
    where j.organization_id = v_org_id and j.assigned_officer_id = p_officer_id and m.at between p_from and p_to
  )
  select * from events order by event_at desc limit least(greatest(coalesce(p_limit, 1000), 1), 5000);
end;
$function$;
COMMENT ON FUNCTION "public"."get_officer_activity_timeline"(p_officer_id uuid, p_from timestamp with time zone, p_to timestamp with time zone, p_limit integer) IS 'Returns the authorized officer evidence timeline and atomically audits each successful access.';
REVOKE ALL ON FUNCTION "public"."get_officer_activity_timeline"(p_officer_id uuid, p_from timestamp with time zone, p_to timestamp with time zone, p_limit integer) FROM PUBLIC, "anon", "authenticated", "service_role";
GRANT EXECUTE ON FUNCTION "public"."get_officer_activity_timeline"(p_officer_id uuid, p_from timestamp with time zone, p_to timestamp with time zone, p_limit integer) TO "postgres";
GRANT EXECUTE ON FUNCTION "public"."get_officer_activity_timeline"(p_officer_id uuid, p_from timestamp with time zone, p_to timestamp with time zone, p_limit integer) TO "authenticated";
GRANT EXECUTE ON FUNCTION "public"."get_officer_activity_timeline"(p_officer_id uuid, p_from timestamp with time zone, p_to timestamp with time zone, p_limit integer) TO "service_role";

create or replace function public.get_officer_activity_timeline_unlogged(p_officer_id uuid, p_from timestamp with time zone, p_to timestamp with time zone, p_limit integer DEFAULT 1000)
 RETURNS TABLE(event_key text, event_type text, event_at timestamp with time zone, received_at timestamp with time zone, source_table text, source_id uuid, gps_lat double precision, gps_lng double precision, shift_id uuid, site_id uuid, zone_id uuid, summary text, details jsonb)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_org_id uuid;
BEGIN
  SELECT organization_id INTO v_org_id FROM public.user_profiles WHERE id = p_officer_id;
  IF v_org_id IS NULL THEN RETURN; END IF;
  IF auth.uid() <> p_officer_id AND NOT public.is_admin_for_org(v_org_id) THEN RAISE EXCEPTION 'Not authorised to view this officer timeline'; END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_from >= p_to OR p_to - p_from > interval '31 days' THEN RAISE EXCEPTION 'Timeline range must be between 1 second and 31 days'; END IF;

  RETURN QUERY
  WITH events AS (
    SELECT 'gps:' || g.id::text, 'gps_' || g.activity_type, g.recorded_at, g.created_at,
      'officer_gps_log'::text, g.id, g.gps_lat, g.gps_lng, g.shift_id, NULL::uuid, g.detected_zone_id,
      CASE WHEN g.activity_type = 'gps_update' THEN 'GPS heartbeat' ELSE replace(g.activity_type, '_', ' ') END,
      jsonb_build_object('accuracy_meters', g.accuracy_meters, 'heading', g.heading, 'speed_kmh', g.speed_kmh, 'physical_address', g.physical_address, 'client_event_id', g.client_event_id)
    FROM public.officer_gps_log g
    WHERE g.organization_id = v_org_id AND g.officer_id = p_officer_id AND g.recorded_at BETWEEN p_from AND p_to

    UNION ALL
    SELECT 'welfare_check:' || w.id::text, 'welfare_check', w.checked_in_at, w.checked_in_at,
      'welfare_checks', w.id, w.gps_lat, w.gps_lng, w.shift_id, NULL::uuid, NULL::uuid,
      'Welfare check-in: ' || w.status, jsonb_build_object('status', w.status, 'notes', w.notes)
    FROM public.welfare_checks w WHERE w.organization_id = v_org_id AND w.officer_user_id = p_officer_id AND w.checked_in_at BETWEEN p_from AND p_to

    UNION ALL
    SELECT 'observation:' || o.id::text, 'observation', o.observed_at, o.created_at,
      'observations', o.id, o.gps_lat, o.gps_lng, NULL::uuid, o.site_id, o.zone_id,
      'Vehicle observation ' || o.plate_number, jsonb_build_object('module_key', o.module_key, 'compliance_status', o.compliance_status, 'plate_number', o.plate_number)
    FROM public.observations o WHERE o.organization_id = v_org_id AND o.officer_id = p_officer_id AND o.observed_at BETWEEN p_from AND p_to

    UNION ALL
    SELECT 'checkpoint:' || v.id::text, 'checkpoint_visit', v.visited_at, v.visited_at,
      'patrol_checkpoint_visits', v.id, v.gps_lat, v.gps_lng, p.shift_id, NULL::uuid, NULL::uuid,
      'Patrol checkpoint visit', jsonb_build_object('checkpoint_id', v.checkpoint_id, 'scan_method', v.scan_method, 'within_radius', v.within_radius, 'notes', v.notes)
    FROM public.patrol_checkpoint_visits v JOIN public.patrols p ON p.id = v.patrol_id
    WHERE v.organization_id = v_org_id AND v.officer_user_id = p_officer_id AND v.visited_at BETWEEN p_from AND p_to

    UNION ALL
    SELECT 'report:' || r.id::text, 'field_report', r.reported_at, r.created_at, 'officer_field_reports', r.id, r.gps_lat, r.gps_lng, r.shift_id, r.site_id, r.zone_id,
      r.title, jsonb_build_object('report_type', r.report_type, 'severity', r.severity, 'status', r.status, 'immediate_action', r.immediate_action)
    FROM public.officer_field_reports r WHERE r.organization_id = v_org_id AND r.officer_id = p_officer_id AND r.reported_at BETWEEN p_from AND p_to

    UNION ALL
    SELECT 'stop_action:' || a.id::text, 'shift_stop_action', a.performed_at, a.created_at,
      'shift_stop_actions', a.id, a.gps_lat, a.gps_lng, a.shift_id, NULL::uuid, NULL::uuid,
      replace(a.action_type, '_', ' '), jsonb_build_object('outcome', a.outcome, 'notes', a.notes, 'result_table', a.result_table, 'result_record_id', a.result_record_id)
    FROM public.shift_stop_actions a JOIN public.shifts s ON s.id = a.shift_id
    WHERE a.organization_id = v_org_id AND s.officer_user_id = p_officer_id AND a.performed_at BETWEEN p_from AND p_to

    UNION ALL
    SELECT 'dispatch_job:' || j.id::text || ':' || m.milestone, 'dispatch_' || m.milestone, m.at, m.at,
      'dispatch_jobs', j.id, NULL::double precision, NULL::double precision, j.shift_id, j.client_site_id, j.zone_id,
      initcap(replace(j.job_type, '_', ' ')) || ' call-out ' || m.label,
      jsonb_build_object('job_type', j.job_type, 'priority', j.priority, 'status', j.status, 'sla_minutes', j.sla_minutes, 'sla_breached', j.sla_breached)
        || CASE WHEN m.milestone = 'completed' THEN jsonb_build_object('outcome_notes', j.outcome_notes) ELSE '{}'::jsonb END
    FROM public.dispatch_jobs j
    CROSS JOIN LATERAL (VALUES ('dispatched', 'dispatched', j.dispatched_at), ('acknowledged', 'acknowledged', j.acknowledged_at),
      ('en_route', 'en route', j.en_route_at), ('on_scene', 'on scene', j.on_scene_at), ('completed', 'completed', j.completed_at)) m(milestone, label, at)
    WHERE j.organization_id = v_org_id AND j.assigned_officer_id = p_officer_id AND m.at BETWEEN p_from AND p_to
  )
  SELECT * FROM events ORDER BY event_at DESC LIMIT least(greatest(coalesce(p_limit, 1000), 1), 5000);
END;
$function$;
REVOKE ALL ON FUNCTION "public"."get_officer_activity_timeline_unlogged"(p_officer_id uuid, p_from timestamp with time zone, p_to timestamp with time zone, p_limit integer) FROM PUBLIC, "anon", "authenticated", "service_role";
GRANT EXECUTE ON FUNCTION "public"."get_officer_activity_timeline_unlogged"(p_officer_id uuid, p_from timestamp with time zone, p_to timestamp with time zone, p_limit integer) TO "postgres";
GRANT EXECUTE ON FUNCTION "public"."get_officer_activity_timeline_unlogged"(p_officer_id uuid, p_from timestamp with time zone, p_to timestamp with time zone, p_limit integer) TO "service_role";


