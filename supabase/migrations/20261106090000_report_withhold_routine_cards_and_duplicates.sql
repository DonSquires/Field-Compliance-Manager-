-- Client report packs (owner ruling 2026-11-06): "if it is just a simple replace
-- card job we don't need to report this" and "if duplicates are detected do not add
-- them into the report again check the date time location, officer and comments".
-- A camera card review whose only content is a card replacement, with no photo, is
-- withheld as routine; an entry repeating another entry's local minute, place,
-- officer, title, comment and action is withheld as a duplicate (the copy with the
-- most photos is kept). Both are accounted for alongside travel and administration.
-- The body is otherwise the live definition of build_agreement_activity_report_core.

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
		('pest_control', 'Pest control', 1),
		('maintenance', 'Maintenance and repairs', 2),
		('manufacture', 'Manufacture and fabrication', 3),
		('installation_removal', 'Installation and removal', 4),
		('securing', 'Securing and access control', 5),
		('inspection', 'Inspections and checks', 6),
		('camera_activation', 'CCTV and camera activity', 7),
		('vehicle_observation', 'Observations', 8),
		('other_work', 'Other site work', 9),
		('administration', 'Administration and review', 10),
		('patrol_visit', 'Patrols', 11),
		('unclassified', 'Other site activity', 12),
		('travel_admin', 'Travel and materials', 13)
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
COMMENT ON FUNCTION "public"."build_agreement_activity_report_core"(p_service_agreement_id uuid, p_from timestamp with time zone, p_to timestamp with time zone, p_max_lines integer) IS 'Internal assembler for the R&M month-end site activity report: what happened at one agreement''s places in a window, as categorised statistics and itemised entries with the comments, action notes, incident descriptions and photos recorded there. Travel, materials and shift or movement markers are withheld from the client report but accounted for, and so is administration (including 0000 desk entries in R&M patrol logs). Every camera card review is reported as a camera observation, except a photo-less card replacement, which is withheld as routine; an entry repeated with the same local minute, place, officer, title, comment and action is withheld as a duplicate. Observation mirror events are excluded so nothing is counted twice. Personal details of identified people in titles, comments and action notes are replaced with "R & M have identified a person relating to this", and NZTA screenshots and identity-document photos are never included. Never copied: costs, officer or staff names, structured plates, GPS, investigation detail or source file names. Auth is on generate_due_report_packs and get_report_pack_activity_accounting.';
REVOKE ALL ON FUNCTION "public"."build_agreement_activity_report_core"(p_service_agreement_id uuid, p_from timestamp with time zone, p_to timestamp with time zone, p_max_lines integer) FROM PUBLIC, "anon", "authenticated", "service_role";
GRANT EXECUTE ON FUNCTION "public"."build_agreement_activity_report_core"(p_service_agreement_id uuid, p_from timestamp with time zone, p_to timestamp with time zone, p_max_lines integer) TO "postgres";
