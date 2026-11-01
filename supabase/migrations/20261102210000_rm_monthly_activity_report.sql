-- R&M month-end activity report.
--
-- Adds an itemised, categorised activity statement to provider-private monthly
-- report drafts: every patrol-log entry, observation and committed workshop work
-- order at the agreement's places, grouped into pest control, maintenance,
-- manufacture, installation and removal, securing, inspection and so on, with
-- statistics, hours, distance and photo counts. A provider-only accounting check
-- shows what was, and what was not, linked to the agreement.
--
-- Privacy tier: operational metadata only. Counts, place names, work-catalogue
-- codes, job reference numbers, distance, recorded job hours, photo counts and
-- ammunition calibre and rounds. Never copied: costs, officer or staff names,
-- plates, narratives (comments, issue, action notes), GPS, or source file names.
-- Every value read from an imported payload is parsed or matched against a strict
-- pattern, so free text cannot reach a client-readable report.

alter table public.monthly_report_packs
	add column if not exists activity_lines jsonb;
alter table public.monthly_report_packs
	drop constraint if exists monthly_report_packs_activity_lines_object;
alter table public.monthly_report_packs
	add constraint monthly_report_packs_activity_lines_object
	check (activity_lines is null or jsonb_typeof(activity_lines) = 'object');
comment on column public.monthly_report_packs.activity_lines is
	'Frozen itemised activity for a monthly report pack: {version, lines[], notItemised}. Operational-metadata tier only (see the activityReport key of data). Kept out of data so report lists do not carry it; read it for one pack at a time.';

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
comment on function public.report_activity_category(text, text, text, text, text, text, text, text) is 'Assigns exactly one report category to a recorded activity entry. Precedence: pest control, manufacture, maintenance, installation and removal, securing, inspection, travel and administration, observations, camera activations, other recorded work, patrol visits without a work type, then unclassified.';
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
	select a.provider_organization_id
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
	select e.id, e.occurred_at, e.event_type, e.source, e.module_key, e.distance_km, e.payload, pl.place_name
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
	select o.id, o.observed_at, o.module_key, o.distance_km,
		case when jsonb_typeof(o.external_refs -> 'import') = 'object' then o.external_refs -> 'import' else '{}'::jsonb end as imported,
		(nullif(btrim(coalesce(o.photo_url, '')), '') is not null
			or nullif(btrim(coalesce(o.original_photo_url, '')), '') is not null
			or nullif(btrim(coalesce(o.watermarked_photo_url, '')), '') is not null) as has_direct_photo,
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
	select w.id, w.kind, w.status, w.order_number,
		coalesce(w.completed_at, w.started_at, w.scheduled_for, w.created_at) as at,
		pl.place_name
	from public.workshop_work_orders w
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
event_photo_counts as (
	select i.location_event_id as record_id, count(distinct i.storage_path) as n
	from public.evidence_items i
	join event_scope e on e.id = i.location_event_id
	where i.evidence_kind = 'photo'
		and i.storage_path is not null
	group by i.location_event_id
),
observation_photo_counts as (
	select u.record_id, count(*) as n
	from (
		select s.observation_id as record_id, s.storage_path
		from public.observation_supporting_evidence s
		join observation_scope o on o.id = s.observation_id
		where s.evidence_kind = 'external_photo'
			and s.storage_path is not null
		union
		select o.id as record_id, i.storage_path
		from public.evidence_items i
		join observation_scope o on o.id::text = i.metadata ->> 'observation_id'
		where i.evidence_kind = 'photo'
			and i.storage_path is not null
	) u
	group by u.record_id
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
		e.distance_km as km,
		public.report_numeric_or_null(e.payload ->> 'job_time_hours') as hours,
		coalesce(p.n, 0)::integer as photos,
		case when jsonb_typeof(e.payload -> 'materials_used') = 'array' then e.payload -> 'materials_used' else '[]'::jsonb end as materials,
		null::text as work_order_status
	from event_scope e
	left join event_photo_counts p on p.record_id = e.id
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
		o.distance_km,
		public.report_numeric_or_null(o.imported ->> 'job_time_hours'),
		(case when o.has_direct_photo then 1 else 0 end + coalesce(p.n, 0))::integer,
		case when jsonb_typeof(o.imported -> 'materials_used') = 'array' then o.imported -> 'materials_used' else '[]'::jsonb end,
		null::text
	from observation_scope o
	left join observation_photo_counts p on p.record_id = o.id
	union all
	select w.id, 'work_order', w.at, w.place_name, 'workshop',
		null::text,
		null::text,
		null::text,
		case w.kind when 'maintenance' then 'maintenance' when 'fabrication' then 'manufacture' end,
		null::text,
		null::text,
		null::text,
		case when w.order_number ~ '^[A-Za-z0-9._/-]{1,24}$' then w.order_number end,
		null::numeric,
		null::numeric,
		0,
		'[]'::jsonb,
		w.status
	from work_order_scope w
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
		a.place_name, a.module_key, a.event_type, a.service_line, a.subject, a.activity, a.species,
		a.equipment, a.material, a.job, a.km, a.hours, a.photos, a.work_order_status,
		ml.materials as materials_used,
		public.report_activity_category(a.kind, a.event_type, a.service_line, a.subject, a.activity, a.species, a.equipment, a.material) as category
	from acts_base a
	left join mat_lines ml on ml.record_id = a.record_id
),
category_catalog(code, label, sort_order) as (
	values
		('pest_control', 'Pest control', 1),
		('manufacture', 'Manufacture and fabrication', 2),
		('maintenance', 'Maintenance and repairs', 3),
		('installation_removal', 'Installation and removal', 4),
		('securing', 'Securing and access control', 5),
		('inspection', 'Inspections and checks', 6),
		('travel_admin', 'Travel, administration and materials', 7),
		('vehicle_observation', 'Vehicle and subject observations', 8),
		('camera_activation', 'Camera activations', 9),
		('other_work', 'Other recorded work', 10),
		('patrol_visit', 'Patrol visits (no work type recorded)', 11),
		('unclassified', 'Not yet classified', 12)
),
service_line_catalog(code, label, sort_order) as (
	values
		('security', 'Security', 1),
		('pest_control', 'Pest control', 2),
		('callout', 'Callout', 3),
		('email', 'Email', 4),
		('fire', 'Fire', 5),
		('other', 'Other source category', 6)
),
labels as (
	select rc.code_type, rc.code, rc.name
	from public.reference_codes rc
	where rc.code_type in ('work_activity', 'work_subject', 'biosecurity_species', 'equipment_type', 'material_type')
		and rc.is_active
		and rc.organization_id = (select provider_organization_id from agreement)
),
used_codes as (
	select 'activity' as dim, activity as code from acts where activity is not null
	union
	select 'subject', subject from acts where subject is not null
	union
	select 'species', species from acts where species is not null
	union
	select 'equipment', equipment from acts where equipment is not null
	union
	select 'material', material from acts where material is not null
	union
	select 'material', material_type from mats
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
		count(*) filter (where kind = 'event' and event_type = 'patrol_visit') as patrol_visits,
		count(*) filter (where kind = 'event' and event_type = 'camera_activation') as camera_activations,
		count(*) filter (where kind = 'event' and event_type = 'patrol_log_unattributed') as unattributed,
		count(distinct place_name) as places,
		coalesce(sum(km), 0) as km,
		coalesce(sum(hours), 0) as hours,
		coalesce(sum(photos) filter (where kind = 'event'), 0) as event_photos,
		coalesce(sum(photos) filter (where kind = 'observation'), 0) as observation_photos
	from acts
),
category_totals as (
	select category, count(*) as entries, coalesce(sum(km), 0) as km,
		coalesce(sum(hours), 0) as hours, coalesce(sum(photos), 0) as photos
	from acts
	group by category
),
service_line_totals as (
	select coalesce(service_line, 'none') as code, count(*) as entries
	from acts
	group by 1
),
place_totals as (
	select coalesce(place_name, 'Not place-specific') as place_name, count(*) as entries, coalesce(sum(km), 0) as km,
		coalesce(sum(hours), 0) as hours, coalesce(sum(photos), 0) as photos
	from acts
	group by 1
),
place_categories as (
	select coalesce(place_name, 'Not place-specific') as place_name, category, count(*) as n
	from acts
	group by 1, 2
),
pest as (
	select * from acts where category = 'pest_control'
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
	select coalesce(activity, 'not_recorded') as code, count(*) as entries, coalesce(sum(hours), 0) as hours
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
	select coalesce(m.calibre, 'unspecified') as calibre, count(distinct m.record_id) as entries, coalesce(sum(m.quantity), 0) as rounds
	from mats m
	join pest p on p.record_id = m.record_id
	where m.material_type = 'ammunition'
	group by 1
),
work_subjects as (
	select category, coalesce(subject, 'not_recorded') as code, count(*) as entries, coalesce(sum(hours), 0) as hours
	from acts
	where category in ('maintenance', 'manufacture')
	group by category, coalesce(subject, 'not_recorded')
),
work_order_status as (
	select category,
		count(*) filter (where work_order_status = 'completed') as completed,
		count(*) filter (where work_order_status in ('approved', 'in_progress')) as open
	from acts
	where kind = 'work_order'
	group by category
),
observation_modules as (
	select coalesce(module_key, 'unknown') as module_key, count(*) as entries,
		count(*) filter (where photos > 0) as with_photo, coalesce(sum(photos), 0) as photos
	from acts
	where kind = 'observation'
	group by 1
),
numbered as (
	select row_number() over (order by a.at, a.place_name, a.category, a.record_id) as n, a.*
	from acts a
),
line_rows as (
	select n.n, jsonb_strip_nulls(jsonb_build_object(
		'd', n.local_date,
		'p', n.place_name,
		'k', n.kind,
		'c', n.category,
		'a', n.activity,
		's', n.subject,
		'sp', n.species,
		'eq', n.equipment,
		'j', n.job,
		'km', nullif(n.km, 0),
		'h', nullif(n.hours, 0),
		'ph', nullif(n.photos, 0),
		'm', n.materials_used,
		'ws', n.work_order_status
	)) as line
	from numbered n
	where n.n <= (select max_lines from params)
),
scope_counts as (
	select
		(select count(*) from event_scope) as events_in_scope,
		(select count(*) from event_scope where source = 'observation_trigger') as mirrors,
		(select count(*) from observation_scope) as observations_in_scope,
		(select count(*) from work_order_scope) as work_orders_in_scope
)
select jsonb_build_object(
	'report', jsonb_build_object(
		'version', 1,
		'basis', 'Recorded activity entries: patrol-log lines, observations and committed workshop work orders at the places covered by this agreement. Counts are recorded entries, not animals or devices; hours and distance are as recorded in the source log.',
		'totals', (select jsonb_build_object(
			'entries', t.entries,
			'events', t.events,
			'observations', t.observations,
			'workOrders', t.work_orders,
			'patrolVisits', t.patrol_visits,
			'cameraActivations', t.camera_activations,
			'unattributedEntries', t.unattributed,
			'places', t.places,
			'travelKm', t.km,
			'hours', round(t.hours, 2),
			'photos', t.event_photos + t.observation_photos
		) from totals t),
		'categories', coalesce((
			select jsonb_agg(jsonb_build_object(
				'code', c.category, 'entries', c.entries, 'km', c.km,
				'hours', round(c.hours, 2), 'photos', c.photos
			) order by c.entries desc, cc.sort_order)
			from category_totals c
			join category_catalog cc on cc.code = c.category
		), '[]'::jsonb),
		'serviceLines', coalesce((
			select jsonb_agg(jsonb_build_object('code', s.code, 'entries', s.entries)
				order by s.entries desc, s.code)
			from service_line_totals s
		), '[]'::jsonb),
		'byPlace', coalesce((
			select jsonb_agg(jsonb_build_object(
				'place', p.place_name, 'entries', p.entries, 'km', p.km,
				'hours', round(p.hours, 2), 'photos', p.photos,
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
			'km', (select coalesce(sum(km), 0) from pest),
			'hours', (select round(coalesce(sum(hours), 0), 2) from pest),
			'bySpecies', coalesce((
				select jsonb_agg(jsonb_build_object(
					'code', s.code, 'culls', s.culls, 'sightings', s.sightings,
					'other', s.total - s.culls - s.sightings, 'total', s.total
				) order by s.total desc, s.code)
				from pest_species s
			), '[]'::jsonb),
			'byActivity', coalesce((
				select jsonb_agg(jsonb_build_object(
					'code', a.code, 'entries', a.entries, 'hours', round(a.hours, 2)
				) order by a.entries desc, a.code)
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
			'entries', (select count(*) from acts where category = 'maintenance'),
			'km', (select coalesce(sum(km), 0) from acts where category = 'maintenance'),
			'hours', (select round(coalesce(sum(hours), 0), 2) from acts where category = 'maintenance'),
			'bySubject', coalesce((
				select jsonb_agg(jsonb_build_object('code', w.code, 'entries', w.entries, 'hours', round(w.hours, 2))
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
			'entries', (select count(*) from acts where category = 'manufacture'),
			'km', (select coalesce(sum(km), 0) from acts where category = 'manufacture'),
			'hours', (select round(coalesce(sum(hours), 0), 2) from acts where category = 'manufacture'),
			'bySubject', coalesce((
				select jsonb_agg(jsonb_build_object('code', w.code, 'entries', w.entries, 'hours', round(w.hours, 2))
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
			'total', (select count(*) from acts where kind = 'observation'),
			'withPhoto', (select count(*) from acts where kind = 'observation' and photos > 0),
			'photos', (select t.observation_photos from totals t),
			'eventPhotos', (select t.event_photos from totals t),
			'byModule', coalesce((
				select jsonb_agg(jsonb_build_object(
					'module', m.module_key, 'entries', m.entries,
					'withPhoto', m.with_photo, 'photos', m.photos
				) order by m.entries desc, m.module_key)
				from observation_modules m
			), '[]'::jsonb)
		),
		'labels', jsonb_build_object(
			'category', coalesce((select jsonb_object_agg(cc.code, cc.label) from category_catalog cc where cc.code in (select category from category_totals)), '{}'::jsonb),
			'serviceLine', coalesce((select jsonb_object_agg(sc.code, sc.label) from service_line_catalog sc where sc.code in (select code from service_line_totals)), '{}'::jsonb),
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
			'entries', t.entries,
			'itemised', (select count(*) from line_rows),
			'notItemised', t.entries - (select count(*) from line_rows),
			'unclassified', coalesce((select ct.entries from category_totals ct where ct.category = 'unclassified'), 0),
			'reconciled', (
				t.entries = (sc.events_in_scope - sc.mirrors) + sc.observations_in_scope + sc.work_orders_in_scope
				and t.entries = (select coalesce(sum(ct.entries), 0) from category_totals ct)
				and t.entries = (select coalesce(sum(pt.entries), 0) from place_totals pt)
			)
		) from scope_counts sc, totals t)
	),
	'lines', jsonb_build_object(
		'version', 1,
		'lines', coalesce((select jsonb_agg(lr.line order by lr.n) from line_rows lr), '[]'::jsonb),
		'notItemised', (select t.entries from totals t) - (select count(*) from line_rows)
	)
);
$function$;
comment on function public.build_agreement_activity_report(uuid, timestamptz, timestamptz, integer) is 'Internal assembler for the R&M month-end activity report: categorised statistics and itemised lines for the entries recorded at one agreement''s places in a window. Observation mirror events are excluded so nothing is counted twice. Operational-metadata tier only; auth is on generate_due_report_packs and get_report_pack_activity_accounting.';
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
		pack.period_start, pack.period_end, pack.status, pack.generated_at,
		pack.data -> 'activityReport' as frozen,
		agreement.client_organization_id
	into v_pack
	from public.monthly_report_packs pack
	join public.service_agreements agreement on agreement.id = pack.service_agreement_id
	where pack.id = p_pack_id;

	if v_pack.id is null then
		raise exception 'Report pack not found';
	end if;
	if not public.is_admin_for_org(v_pack.organization_id) then
		raise exception 'Provider administrator access required';
	end if;
	if v_pack.report_kind <> 'monthly' then
		raise exception 'Activity accounting is available for monthly report packs only';
	end if;

	-- Same window as generate_due_report_packs.
	v_from := v_pack.period_start::timestamptz;
	v_to := v_pack.period_end::timestamptz + interval '1 day';
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
			left join public.file_import_batches b on b.id = s.batch_id
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
		'status', v_pack.status,
		'period', jsonb_build_object('start', v_pack.period_start, 'end', v_pack.period_end),
		'generatedAt', v_pack.generated_at,
		'checkedAt', now(),
		'freshness', jsonb_build_object(
			'hasFrozenReport', v_frozen is not null,
			'frozenEntries', (v_frozen -> 'totals' ->> 'entries')::integer,
			'liveEntries', (v_live -> 'totals' ->> 'entries')::integer,
			'matchesLive', v_frozen is not null
				and (v_frozen -> 'totals') = (v_live -> 'totals')
				and jsonb_array_length(v_categories) = 0,
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
-- the activity report merged into data and the itemised lines written to
-- activity_lines. Sent packs stay immutable.
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
comment on function public.generate_due_report_packs(date, date, uuid) is 'Assembles provider-private draft report packs for one authorized agreement or all eligible agreements when no ID is supplied. Activity metrics are aggregated only from agreement-linked places; the activityReport key and activity_lines column carry the categorised and itemised R&M month-end activity statement. Narrative fields, identities, plates and costs are excluded.';
revoke all on function public.generate_due_report_packs(date, date, uuid) from public, anon, authenticated, service_role;
grant execute on function public.generate_due_report_packs(date, date, uuid) to postgres;
grant execute on function public.generate_due_report_packs(date, date, uuid) to authenticated;
grant execute on function public.generate_due_report_packs(date, date, uuid) to service_role;
