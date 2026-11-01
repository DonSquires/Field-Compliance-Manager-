-- R&M month-end site activity report.
--
-- Adds an itemised, categorised statement of what happened at the agreement's
-- places to provider-private monthly report drafts: every patrol-log entry,
-- observation, committed workshop work order and client-visible incident, grouped into
-- incidents, pest control, maintenance, manufacture, installation and removal,
-- securing, inspection, CCTV, observations and patrols, with the comments, action
-- notes and photos recorded at each place. A provider-only accounting check shows
-- what was, and what was not, linked to the agreement.
--
-- Client tier: place names, dates and times, work-catalogue codes, job and
-- investigation references, ammunition calibre and rounds, photo references, and
-- the narratives written at the place (comment, issue, action notes, observation
-- notes, work-order title, description and completion note, incident
-- description). The owner chose to include narratives in the client-readable
-- activity stream (docs/RM_ONBOARDING_TRACKER.md); the provider reviews every
-- draft before it is published.
-- Never copied: costs, officer or staff names, structured plates, GPS, source file
-- names, investigation titles, summaries or resolution notes, or staff-sensitive
-- incidents. Travel, administration and shift or movement markers are operational
-- and are withheld from the client report but still accounted for. Codes and
-- references are matched against strict patterns and narratives are normalised
-- and length-capped.

alter table public.monthly_report_packs
	add column if not exists activity_lines jsonb;
alter table public.monthly_report_packs
	drop constraint if exists monthly_report_packs_activity_lines_object;
alter table public.monthly_report_packs
	add constraint monthly_report_packs_activity_lines_object
	check (activity_lines is null or jsonb_typeof(activity_lines) = 'object');
comment on column public.monthly_report_packs.activity_lines is
	'Frozen itemised site activity for a monthly report pack: {version, lines[], notItemised}. Each line is one client-reportable entry with its place, date and time, category, recorded narrative and photo references (see the activityReport key of data). Kept out of data so report lists do not carry it; read it for one pack at a time.';

create or replace function public.report_numeric_or_null(p_value text)
returns numeric
language sql
immutable
set search_path to 'pg_catalog'
as $function$
	select case
		when p_value is not null
			and p_value <> ''
			and p_value ~ '^[0-9]{0,9}(\.[0-9]{1,6})?$'
		then p_value::numeric
	end;
$function$;
comment on function public.report_numeric_or_null(text) is 'Parses a non-negative decimal from imported text, or returns null. Used so report statistics never cast free text.';
revoke all on function public.report_numeric_or_null(text) from public, anon, authenticated, service_role;
grant execute on function public.report_numeric_or_null(text) to postgres;

create or replace function public.report_code_or_null(p_value text)
returns text
language sql
immutable
set search_path to 'pg_catalog'
as $function$
	select case when p_value ~ '^[a-z][a-z0-9_]{0,40}$' then p_value end;
$function$;
comment on function public.report_code_or_null(text) is 'Returns a work-catalogue style code (lower snake case) or null, so only catalogue codes can be copied from imported payloads into reports.';
revoke all on function public.report_code_or_null(text) from public, anon, authenticated, service_role;
grant execute on function public.report_code_or_null(text) to postgres;

create or replace function public.report_service_line(p_value text)
returns text
language sql
immutable
set search_path to 'pg_catalog'
as $function$
	select case regexp_replace(lower(btrim(coalesce(p_value, ''))), '[\s_]+', ' ', 'g')
		when '' then null
		when 'security' then 'security'
		when 'pest control' then 'pest_control'
		when 'callout' then 'callout'
		when 'email' then 'email'
		when 'fire' then 'fire'
		else 'other'
	end;
$function$;
comment on function public.report_service_line(text) is 'Maps the spreadsheet source category (SECURITY, PEST CONTROL, CALLOUT, EMAIL, FIRE) to a code. Any other value becomes other so source text is never copied.';
revoke all on function public.report_service_line(text) from public, anon, authenticated, service_role;
grant execute on function public.report_service_line(text) to postgres;

create or replace function public.report_text_or_null(p_value text, p_max_length integer)
returns text
language sql
immutable
set search_path to 'pg_catalog'
as $function$
	select case
		when s.cleaned = '' then null
		when length(s.cleaned) > greatest(coalesce(p_max_length, 1), 2)
			then rtrim(left(s.cleaned, greatest(coalesce(p_max_length, 1), 2) - 1)) || '…'
		else s.cleaned
	end
	from (
		select btrim(regexp_replace(coalesce(p_value, ''), '[[:cntrl:][:space:]]+', ' ', 'g')) as cleaned
	) s;
$function$;
comment on function public.report_text_or_null(text, integer) is 'Normalises a narrative written at a location (comment, action note, description) for a client report: control characters and runs of whitespace become one space, blank becomes null, and long text is capped with an ellipsis.';
revoke all on function public.report_text_or_null(text, integer) from public, anon, authenticated, service_role;
grant execute on function public.report_text_or_null(text, integer) to postgres;

create or replace function public.report_activity_category(
	p_kind text,
	p_event_type text,
	p_service_line text,
	p_subject text,
	p_activity text,
	p_species text,
	p_equipment text,
	p_material text
)
returns text
language sql
immutable
set search_path to 'pg_catalog'
as $function$
	select case
		when p_kind = 'incident' then 'incident'
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
comment on function public.report_activity_category(text, text, text, text, text, text, text, text) is 'Assigns exactly one report category to a recorded activity entry. Precedence: incidents, pest control, manufacture, maintenance, installation and removal, securing, inspection, travel and administration, observations, camera activations, other recorded work, patrol visits without a work type, then other site activity.';
revoke all on function public.report_activity_category(text, text, text, text, text, text, text, text) from public, anon, authenticated, service_role;
grant execute on function public.report_activity_category(text, text, text, text, text, text, text, text) to postgres;

create or replace function public.build_agreement_activity_report(
	p_service_agreement_id uuid,
	p_from timestamptz,
	p_to timestamptz,
	p_max_lines integer default 2000
)
returns jsonb
language sql
stable
security definer
set search_path to 'pg_catalog'
as $function$
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
	select e.id, e.occurred_at, e.event_type, e.source, e.module_key, e.payload, pl.place_name
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
	select o.id, o.observed_at, o.module_key, o.officer_notes,
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
		union all
		select o.id,
			case when s.storage_path = any(o.direct_photo_paths) then 'scans' else s.storage_bucket end,
			case when s.storage_path = any(o.direct_photo_paths) then o.direct_photo_paths[1] else s.storage_path end,
			s.captured_at, 1
		from public.observation_supporting_evidence s
		join observation_scope o on o.id = s.observation_id
		where s.evidence_kind = 'external_photo'
			and s.storage_path is not null
		union all
		select o.id,
			case when i.storage_path = any(o.direct_photo_paths) then 'scans' else 'bob-uploads' end,
			case when i.storage_path = any(o.direct_photo_paths) then o.direct_photo_paths[1] else i.storage_path end,
			i.captured_at, 3
		from public.evidence_items i
		join observation_scope o on o.id::text = i.metadata ->> 'observation_id'
		where i.evidence_kind = 'photo'
			and i.storage_path is not null
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
		union all
		select n.id, 'bob-uploads', i.storage_path, i.captured_at, 3
		from incident_scope n
		join public.evidence_items i on i.location_event_id = n.location_event_id
		where i.evidence_kind = 'photo'
			and i.storage_path is not null
	) r
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
		-- Travel, administration and shift or movement markers are how the work was
		-- run, not what happened at the place, so the client report withholds them.
		-- Photos and service-line classifications do not override this boundary.
		case
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
		end as withheld_reason
	from acts_base a
	left join mat_lines ml on ml.record_id = a.record_id
	left join photo_counts pc on pc.record_id = a.record_id
	left join incident_videos iv on iv.record_id = a.record_id
	cross join lateral (
		select public.report_activity_category(a.kind, a.event_type, a.service_line, a.subject, a.activity, a.species, a.equipment, a.material) as category
	) c
),
vis as materialized (
	select * from acts where withheld_reason is null
),
category_catalog(code, label, sort_order) as (
	values
		('incident', 'Incidents and investigations', 0),
		('pest_control', 'Pest control', 1),
		('maintenance', 'Maintenance and repairs', 2),
		('manufacture', 'Manufacture and fabrication', 3),
		('installation_removal', 'Installation and removal', 4),
		('securing', 'Securing and access control', 5),
		('inspection', 'Inspections and checks', 6),
		('camera_activation', 'CCTV and camera activity', 7),
		('vehicle_observation', 'Observations', 8),
		('other_work', 'Other site work', 9),
		('patrol_visit', 'Patrols', 10),
		('unclassified', 'Other site activity', 11),
		('travel_admin', 'Travel and administration', 12)
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
		count(*) filter (where kind = 'event' and event_type = 'patrol_visit') as patrol_visits,
		count(*) filter (where kind = 'event' and event_type = 'camera_activation') as camera_activations,
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
		'ti', n.title,
		'n', n.note,
		'ac', n.action,
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
		(select count(*) filter (where withheld_reason = 'shift_marker') from acts) as withheld_shift_markers
)
select jsonb_build_object(
	'report', jsonb_build_object(
		'version', 2,
		'itemisedDigest', (select md5(coalesce(string_agg(md5(lr.line::text), '' order by lr.n), '')) from all_line_rows lr),
		'basis', 'Activity recorded at the locations covered by this agreement: patrols and site checks, observations, pest control, maintenance and manufacture, CCTV and incidents. Counts are recorded entries, not animals or devices.',
		'totals', (select jsonb_build_object(
			'entries', t.entries,
			'events', t.events,
			'observations', t.observations,
			'workOrders', t.work_orders,
			'incidents', t.incidents,
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
			'operationalWithheld', sc.withheld_travel_admin + sc.withheld_shift_markers,
			'withheldTravelAdmin', sc.withheld_travel_admin,
			'withheldShiftMarkers', sc.withheld_shift_markers,
			'itemised', (select count(*) from line_rows),
			'notItemised', t.entries - (select count(*) from line_rows),
			'unclassified', coalesce((select ct.entries from category_totals ct where ct.category = 'unclassified'), 0),
			'reconciled', (
				sc.all_entries = (sc.events_in_scope - sc.mirrors) + sc.observations_in_scope + sc.work_orders_in_scope + sc.incidents_in_scope
				and sc.all_entries = t.entries + sc.withheld_travel_admin + sc.withheld_shift_markers
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
comment on function public.build_agreement_activity_report(uuid, timestamptz, timestamptz, integer) is 'Internal assembler for the R&M month-end site activity report: what happened at one agreement''s places in a window, as categorised statistics and itemised entries with the comments, action notes, incident descriptions and photos recorded there. Travel, administration and shift or movement markers are withheld from the client report but accounted for. Observation mirror events are excluded so nothing is counted twice. Never copied: costs, officer or staff names, structured plates, GPS, investigation detail or source file names. Auth is on generate_due_report_packs and get_report_pack_activity_accounting.';
revoke all on function public.build_agreement_activity_report(uuid, timestamptz, timestamptz, integer) from public, anon, authenticated, service_role;
grant execute on function public.build_agreement_activity_report(uuid, timestamptz, timestamptz, integer) to postgres;

-- Provider-only accounting for one monthly pack. Computed live on request and
-- never stored, because it names source files and places the client did not buy.
create or replace function public.get_report_pack_activity_accounting(p_pack_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'pg_catalog'
as $function$
declare
	v_pack record;
	v_from timestamptz;
	v_to timestamptz;
	v_live jsonb;
	v_frozen jsonb;
	v_categories jsonb;
	v_provenance jsonb;
	v_sources jsonb;
	v_client_month jsonb;
	v_exceptions jsonb;
begin
	if auth.uid() is null then
		raise exception 'Authenticated provider administrator required';
	end if;

	select pack.id, pack.organization_id, pack.service_agreement_id, pack.report_kind,
		pack.period_start, pack.period_end, pack.status, pack.generated_at, pack.updated_at,
		pack.data -> 'activityReport' as frozen,
		agreement.client_organization_id
	into v_pack
	from public.monthly_report_packs pack
	join public.service_agreements agreement on agreement.id = pack.service_agreement_id
	where pack.id = p_pack_id;

	if v_pack.id is null then
		raise exception 'Report pack not found';
	end if;
	if not public.is_report_provider_custodian_for_org(v_pack.organization_id) then
		raise exception 'Provider administrator access required';
	end if;
	if v_pack.report_kind <> 'monthly' then
		raise exception 'Activity accounting is available for monthly report packs only';
	end if;

	-- Same window as generate_due_report_packs.
	v_from := v_pack.period_start::timestamp at time zone 'Pacific/Auckland';
	v_to := (v_pack.period_end + 1)::timestamp at time zone 'Pacific/Auckland';
	v_live := public.build_agreement_activity_report(v_pack.service_agreement_id, v_from, v_to, 0) -> 'report';
	v_frozen := case when jsonb_typeof(v_pack.frozen) = 'object' then v_pack.frozen end;

	select coalesce(jsonb_agg(jsonb_build_object(
			'code', coalesce(f.code, l.code),
			'frozen', coalesce(f.entries, 0),
			'live', coalesce(l.entries, 0)
		) order by coalesce(f.code, l.code)), '[]'::jsonb)
	into v_categories
	from (
		select c ->> 'code' as code, (c ->> 'entries')::integer as entries
		from jsonb_array_elements(coalesce(v_frozen -> 'categories', '[]'::jsonb)) c
	) f
	full join (
		select c ->> 'code' as code, (c ->> 'entries')::integer as entries
		from jsonb_array_elements(coalesce(v_live -> 'categories', '[]'::jsonb)) c
	) l on l.code = f.code
	where coalesce(f.entries, 0) <> coalesce(l.entries, 0);

	with
	links as (
		select l.site_id, l.zone_id
		from public.service_agreement_locations l
		where l.service_agreement_id = v_pack.service_agreement_id
			and l.status = 'active'
	),
	scoped as (
		select 'event'::text as record_kind, e.id
		from public.location_events e
		where e.occurred_at >= v_from
			and e.occurred_at < v_to
			and e.source is distinct from 'observation_trigger'
			and exists (
				select 1 from links k
				where (k.zone_id is not null and k.zone_id = e.zone_id)
					or (k.site_id is not null and k.site_id = e.client_site_id)
			)
		union all
		select 'observation', o.id
		from public.observations o
		where o.observed_at >= v_from
			and o.observed_at < v_to
			and exists (
				select 1 from links k
				where (k.zone_id is not null and k.zone_id = o.zone_id)
					or (k.site_id is not null and k.site_id = o.site_id)
			)
	),
	ledger as (
		select s.record_kind, s.id, v.source_file, v.source_sheet, v.batch_id
		from scoped s
		left join lateral (
			select r.source_file, r.source_sheet, r.batch_id
			from public.patrol_import_record_versions r
			where r.record_kind = s.record_kind
				and r.record_id = s.id
				and r.is_current
				and r.provider_organization_id = v_pack.organization_id
				and r.client_organization_id = v_pack.client_organization_id
			order by r.version_no desc
			limit 1
		) v on true
	),
	counts as (
		select
			count(*) filter (where record_kind = 'event') as events,
			count(*) filter (where record_kind = 'event' and batch_id is not null) as events_ledger,
			count(*) filter (where record_kind = 'observation') as observations,
			count(*) filter (where record_kind = 'observation' and batch_id is not null) as observations_ledger
		from ledger
	),
	sources as (
		select l.source_file, l.source_sheet, l.batch_id,
			count(*) filter (where l.record_kind = 'event') as events,
			count(*) filter (where l.record_kind = 'observation') as observations
		from ledger l
		where l.batch_id is not null
		group by l.source_file, l.source_sheet, l.batch_id
	)
	select
		(select jsonb_build_object(
			'events', jsonb_build_object('inScope', c.events, 'withLedger', c.events_ledger, 'withoutLedger', c.events - c.events_ledger),
			'observations', jsonb_build_object('inScope', c.observations, 'withLedger', c.observations_ledger, 'withoutLedger', c.observations - c.observations_ledger)
		) from counts c),
		coalesce((
			select jsonb_agg(jsonb_build_object(
				'sourceFile', s.source_file,
				'sourceSheet', s.source_sheet,
				'batchId', s.batch_id,
				'batchStatus', b.status,
				'batchRows', b.row_count,
				'batchDuplicates', b.duplicate_count,
				'batchUnresolved', b.unresolved_count,
				'events', s.events,
				'observations', s.observations
			) order by s.events + s.observations desc, s.source_file, s.source_sheet)
			from (select * from sources order by events + observations desc, source_file, source_sheet limit 50) s
			left join public.file_import_batches b on b.id = s.batch_id and b.organization_id = v_pack.organization_id
		), '[]'::jsonb)
	into v_provenance, v_sources;

	with
	client_records as (
		select e.id, e.zone_id, e.client_site_id as site_id
		from public.location_events e
		where e.occurred_at >= v_from
			and e.occurred_at < v_to
			and e.source is distinct from 'observation_trigger'
			and (
				e.organization_id = v_pack.client_organization_id
				or exists (
					select 1 from public.patrol_import_record_versions r
					where r.record_kind = 'event' and r.record_id = e.id and r.is_current
						and r.provider_organization_id = v_pack.organization_id
						and r.client_organization_id = v_pack.client_organization_id
				)
			)
		union all
		select o.id, o.zone_id, o.site_id
		from public.observations o
		where o.observed_at >= v_from
			and o.observed_at < v_to
			and (
				o.organization_id = v_pack.client_organization_id
				or exists (
					select 1 from public.patrol_import_record_versions r
					where r.record_kind = 'observation' and r.record_id = o.id and r.is_current
						and r.provider_organization_id = v_pack.organization_id
						and r.client_organization_id = v_pack.client_organization_id
				)
			)
	),
	classified as (
		select c.*,
			case
				when exists (
					select 1 from public.service_agreement_locations l
					where l.service_agreement_id = v_pack.service_agreement_id and l.status = 'active'
						and ((l.zone_id is not null and l.zone_id = c.zone_id) or (l.site_id is not null and l.site_id = c.site_id))
				) then 'this_agreement'
				when exists (
					select 1 from public.service_agreement_locations l
					where l.service_agreement_id <> v_pack.service_agreement_id and l.status = 'active'
						and ((l.zone_id is not null and l.zone_id = c.zone_id) or (l.site_id is not null and l.site_id = c.site_id))
				) then 'other_agreement'
				else 'no_agreement_place'
			end as bucket
		from client_records c
	)
	select jsonb_build_object(
		'entries', count(*),
		'thisAgreement', count(*) filter (where bucket = 'this_agreement'),
		'otherAgreements', count(*) filter (where bucket = 'other_agreement'),
		'noAgreementPlace', count(*) filter (where bucket = 'no_agreement_place'),
		'unlinkedPlaces', coalesce((
			select jsonb_agg(jsonb_build_object('place', u.place, 'entries', u.n) order by u.n desc, u.place)
			from (
				select coalesce(s.name, z.name, 'No place recorded') as place, count(*) as n
				from classified x
				left join public.client_sites s on s.id = x.site_id
				left join public.location_zones z on z.id = x.zone_id
				where x.bucket = 'no_agreement_place'
				group by 1
				order by 2 desc, 1
				limit 10
			) u
		), '[]'::jsonb)
	)
	into v_client_month
	from classified;

	with client_years as (
		select extract(year from e.occurred_at at time zone 'Pacific/Auckland')::integer as year, count(*) as n
		from public.location_events e
		where e.organization_id = v_pack.client_organization_id
			and e.source is distinct from 'observation_trigger'
		group by 1
	)
	select jsonb_build_object(
		'futureDated', (
			select count(*) from public.location_events e
			where e.organization_id = v_pack.client_organization_id
				and e.source is distinct from 'observation_trigger'
				and e.occurred_at > now() + interval '1 day'
		) + (
			select count(*) from public.observations o
			where o.organization_id = v_pack.client_organization_id
				and o.observed_at > now() + interval '1 day'
		),
		'sparseYears', coalesce((
			select jsonb_agg(jsonb_build_object('year', y.year, 'entries', y.n) order by y.year)
			from client_years y
			where y.n < 50
		), '[]'::jsonb),
		'supersededDuplicates', (
			select count(*)
			from public.location_events_superseded d
			where (d.event_snapshot ->> 'occurred_at') ~ '^\d{4}-\d{2}-\d{2}'
				and (d.event_snapshot ->> 'occurred_at')::timestamptz >= v_from
				and (d.event_snapshot ->> 'occurred_at')::timestamptz < v_to
				and exists (
					select 1 from public.service_agreement_locations l
					where l.service_agreement_id = v_pack.service_agreement_id and l.status = 'active'
						and ((l.zone_id is not null and (l.zone_id)::text = d.event_snapshot ->> 'zone_id')
							or (l.site_id is not null and (l.site_id)::text = d.event_snapshot ->> 'client_site_id'))
				)
		)
	)
	into v_exceptions;

	return jsonb_build_object(
		'version', 1,
		'packId', v_pack.id,
		'packUpdatedAt', v_pack.updated_at,
		'status', v_pack.status,
		'period', jsonb_build_object('start', v_pack.period_start, 'end', v_pack.period_end),
		'generatedAt', v_pack.generated_at,
		'checkedAt', now(),
		'freshness', jsonb_build_object(
			'hasFrozenReport', v_frozen is not null,
			'frozenEntries', (v_frozen -> 'totals' ->> 'entries')::integer,
			'liveEntries', (v_live -> 'totals' ->> 'entries')::integer,
			'matchesLive', v_frozen is not null
				and (v_frozen #- '{accountedFor,itemised}' #- '{accountedFor,notItemised}')
					= (v_live #- '{accountedFor,itemised}' #- '{accountedFor,notItemised}'),
			'changedCategories', v_categories
		),
		'live', jsonb_build_object(
			'totals', v_live -> 'totals',
			'accountedFor', v_live -> 'accountedFor'
		),
		'provenance', v_provenance || jsonb_build_object('sources', v_sources),
		'clientMonth', v_client_month,
		'exceptions', v_exceptions
	);
end;
$function$;
comment on function public.get_report_pack_activity_accounting(uuid) is 'Provider-only, read-only accounting for a monthly report pack: frozen versus live activity totals, import-ledger provenance per source file and batch, the client''s month split into this agreement, other agreements and unlinked places, and date and duplicate exceptions. Never persisted to client-readable data.';
revoke all on function public.get_report_pack_activity_accounting(uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_report_pack_activity_accounting(uuid) to postgres;
grant execute on function public.get_report_pack_activity_accounting(uuid) to authenticated;

-- Body copied from the live catalog (supabase/schema.sql); the only changes are
-- the activity report merged into data, the itemised lines written to
-- activity_lines and explicit New Zealand date boundaries. Sent packs stay immutable.
create or replace function public.generate_due_report_packs(p_period_start date, p_period_end date, p_service_agreement_id uuid)
returns integer
language plpgsql
security definer
set search_path to 'pg_catalog'
as $function$
declare
	v_actor uuid := auth.uid();
	v_provider uuid;
	v_agreement record;
	v_count integer := 0;
	v_written integer;
	v_data jsonb;
	v_start_ts timestamptz := p_period_start::timestamp at time zone 'Pacific/Auckland';
	v_end_ts timestamptz := (p_period_end + 1)::timestamp at time zone 'Pacific/Auckland';
	v_sla_met integer;
	v_sla_breached integer;
	v_sla_running integer;
	v_inc_total integer;
	v_inc_by_sev jsonb;
	v_checkpoints integer;
	v_breaches integer;
	v_delivery jsonb;
	v_facilities jsonb;
	v_operational_events integer;
	v_patrol_visits integer;
	v_camera_activations integer;
	v_vehicle_observations integer;
	v_event_distance_km numeric;
	v_observation_distance_km numeric;
	v_activity jsonb;
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

	if p_service_agreement_id is not null and not exists (
		select 1
		from public.service_agreements agreement
		where agreement.id = p_service_agreement_id
			and agreement.provider_organization_id = any(public.get_descendant_organizations(v_provider))
			and agreement.agreement_type = 'operational'
			and agreement.monthly_report_template_code is not null
	) then
		raise exception 'Service agreement is not available for report generation';
	end if;

	for v_agreement in
		select agreement.id, agreement.provider_organization_id,
					 agreement.monthly_report_template_code
		from public.service_agreements agreement
		where agreement.provider_organization_id = any(public.get_descendant_organizations(v_provider))
			and agreement.monthly_report_template_code is not null
			and (
				p_service_agreement_id is null
				or (
					agreement.id = p_service_agreement_id
					and agreement.agreement_type = 'operational'
				)
			)
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

		select count(*),
					 count(*) filter (where event.event_type = 'patrol_visit'),
					 count(*) filter (where event.event_type = 'camera_activation'),
					 coalesce(sum(event.distance_km), 0)
		into v_operational_events, v_patrol_visits, v_camera_activations, v_event_distance_km
		from public.location_events event
		where event.occurred_at >= v_start_ts
			and event.occurred_at < v_end_ts
			and exists (
				select 1
				from public.service_agreement_locations link
				where link.service_agreement_id = v_agreement.id
					and link.status = 'active'
					and (
						(link.zone_id is not null and link.zone_id = event.zone_id)
						or (link.site_id is not null and link.site_id = event.client_site_id)
					)
			);

		select count(*), coalesce(sum(observation.distance_km), 0)
		into v_vehicle_observations, v_observation_distance_km
		from public.observations observation
		where observation.observed_at >= v_start_ts
			and observation.observed_at < v_end_ts
			and exists (
				select 1
				from public.service_agreement_locations link
				where link.service_agreement_id = v_agreement.id
					and link.status = 'active'
					and (
						(link.zone_id is not null and link.zone_id = observation.zone_id)
						or (link.site_id is not null and link.site_id = observation.site_id)
					)
			);

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

		v_activity := public.build_agreement_activity_report(v_agreement.id, v_start_ts, v_end_ts, 2000);

		v_data := jsonb_build_object(
			'slaMet', coalesce(v_sla_met, 0),
			'slaBreached', coalesce(v_sla_breached, 0),
			'slaRunning', coalesce(v_sla_running, 0),
			'incidentsTotal', coalesce(v_inc_total, 0),
			'incidentsBySeverity', coalesce(v_inc_by_sev, '{}'::jsonb),
			'checkpointVisits', coalesce(v_checkpoints, 0),
			'breachAlerts', coalesce(v_breaches, 0),
			'facilities', v_facilities,
			'delivery', v_delivery,
			'operationalEvents', coalesce(v_operational_events, 0),
			'patrolVisits', coalesce(v_patrol_visits, 0),
			'cameraActivations', coalesce(v_camera_activations, 0),
			'vehicleObservations', coalesce(v_vehicle_observations, 0),
			'patrolTravelKm', coalesce(v_event_distance_km, 0) + coalesce(v_observation_distance_km, 0),
			'activityReport', v_activity -> 'report'
		);

		insert into public.monthly_report_packs as existing (
			organization_id, service_agreement_id, template_code, period_start,
			period_end, status, data, activity_lines, generated_at, generated_by, updated_at
		) values (
			v_agreement.provider_organization_id,
			v_agreement.id,
			v_agreement.monthly_report_template_code,
			p_period_start,
			p_period_end,
			'draft',
			v_data,
			v_activity -> 'lines',
			clock_timestamp(),
			v_actor,
			clock_timestamp()
		)
		on conflict (service_agreement_id, template_code, period_start)
		do update set
			period_end = excluded.period_end,
			data = excluded.data,
			activity_lines = excluded.activity_lines,
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
			'service_agreement_id', p_service_agreement_id,
			'status', 'draft'
		)
	);

	return v_count;
end;
$function$;
comment on function public.generate_due_report_packs(date, date, uuid) is 'Assembles provider-private draft report packs for one authorized agreement or all eligible agreements when no ID is supplied. Activity metrics are aggregated only from agreement-linked places; the activityReport key and activity_lines column carry the categorised and itemised R&M month-end site activity report, including the narratives and photo references recorded at each place. Travel, administration and shift markers are withheld from it; names, structured plates, costs, GPS and source file names are never copied. Report periods use New Zealand (Pacific/Auckland) day boundaries. Sent packs are never regenerated.';
revoke all on function public.generate_due_report_packs(date, date, uuid) from public, anon, authenticated, service_role;
grant execute on function public.generate_due_report_packs(date, date, uuid) to postgres;
grant execute on function public.generate_due_report_packs(date, date, uuid) to authenticated;
grant execute on function public.generate_due_report_packs(date, date, uuid) to service_role;
