-- Client report disclosure is data, not code (owner ruling 2026-11-09): "the app
-- and bob runs on data not hard coding, this should be deterministic and
-- huristic and agentic using training and knowledge cards".
--
-- build_agreement_activity_report_core used to carry its withholding vocabulary
-- (travel/admin titles, shift markers, card-swap phrases, card review and desk
-- 0000 categories) and its category catalogue as literals. Those now live in:
--   report_activity_categories  - the category catalogue (label, order)
--   report_disclosure_reasons   - why an entry is kept out of the client report
--   report_disclosure_rules     - ordered, scoped condition rules that either
--                                 categorise an entry or withhold it
-- Rules are platform defaults (provider_organization_id null) that a provider,
-- or a provider for one client, can override by rule_code. The report core
-- interprets the rows deterministically; Bob reads the knowledge card below to
-- propose new rules from evidence. Exact duplicates stay a structural check.
--
-- New platform rule (owner ruling 2026-11-09, TPFL and OFO packs): a status-only
-- inspection (gate open/closed, lock check, "Live", "Dead", "Secure",
-- "Working", no photo, no action) is a non-event and is withheld from every
-- client's report. It is still counted in the completeness check.

create table if not exists public.report_activity_categories (
	code text primary key check (code ~ '^[a-z][a-z0-9_]{1,63}$'),
	label text not null check (length(btrim(label)) between 1 and 80),
	sort_order integer not null default 100,
	is_active boolean not null default true,
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now()
);
comment on table public.report_activity_categories is 'Client activity report category catalogue (label and order). Read by build_agreement_activity_report_core; categories are assigned by report_activity_category() and report_disclosure_rules.';

create table if not exists public.report_disclosure_reasons (
	code text primary key check (code ~ '^[a-z][a-z0-9_]{1,63}$'),
	label_one text not null check (length(btrim(label_one)) between 1 and 120),
	label_many text not null check (length(btrim(label_many)) between 1 and 120),
	description text,
	sort_order integer not null default 100,
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now()
);
comment on table public.report_disclosure_reasons is 'Why an entry is kept out of a client activity report. Shown in the provider-only completeness check; every withheld entry is still accounted for.';

create or replace function public.report_rule_conditions_valid(p_conditions jsonb)
 returns boolean
 language sql
 immutable
 set search_path to 'pg_catalog'
as $function$
	select jsonb_typeof(p_conditions) = 'array'
		and not exists (
			select 1
			from jsonb_array_elements(p_conditions) c
			where jsonb_typeof(c) <> 'object'
				or coalesce(c ->> 'field', '') !~ '^[a-z][a-z_]{0,31}$'
				or coalesce(c ->> 'operator', '') not in ('in', 'not_in', 'regex', 'not_regex', 'empty', 'non_empty', 'max', 'min')
				or coalesce(c ->> 'normalize', 'lower') not in ('lower', 'letters', 'words')
				or (c ->> 'operator' in ('in', 'not_in') and jsonb_typeof(c -> 'values') is distinct from 'array')
				or (c ->> 'operator' in ('regex', 'not_regex') and jsonb_typeof(c -> 'value') is distinct from 'string')
				or (c ->> 'operator' in ('max', 'min') and jsonb_typeof(c -> 'value') is distinct from 'number')
		);
$function$;

-- Evaluates one rule's conditions (all must hold) against an entry's facts.
-- normalize: lower (trimmed lower case, default), letters (a-z only),
-- words (a-z words separated by single spaces). Missing facts read as ''.
create or replace function public.report_rule_conditions_match(p_conditions jsonb, p_facts jsonb)
 returns boolean
 language sql
 immutable
 set search_path to 'pg_catalog'
as $function$
	select coalesce(bool_and(
		case c ->> 'operator'
			when 'in' then (c -> 'values') ? x.v
			when 'not_in' then not ((c -> 'values') ? x.v)
			when 'regex' then x.v ~ (c ->> 'value')
			when 'not_regex' then x.v !~ (c ->> 'value')
			when 'empty' then x.v = ''
			when 'non_empty' then x.v <> ''
			when 'max' then case when x.v ~ '^-?[0-9]+(\.[0-9]+)?$' then x.v::numeric <= (c ->> 'value')::numeric else false end
			when 'min' then case when x.v ~ '^-?[0-9]+(\.[0-9]+)?$' then x.v::numeric >= (c ->> 'value')::numeric else false end
			else false
		end), true)
	from jsonb_array_elements(p_conditions) c
	cross join lateral (
		select case coalesce(c ->> 'normalize', 'lower')
			when 'letters' then regexp_replace(lower(coalesce(p_facts ->> (c ->> 'field'), '')), '[^a-z]', '', 'g')
			when 'words' then btrim(regexp_replace(lower(coalesce(p_facts ->> (c ->> 'field'), '')), '[^a-z]+', ' ', 'g'))
			else lower(btrim(coalesce(p_facts ->> (c ->> 'field'), '')))
		end as v
	) x;
$function$;

create table if not exists public.report_disclosure_rules (
	id uuid primary key default gen_random_uuid(),
	provider_organization_id uuid references public.organizations(id) on delete cascade,
	client_organization_id uuid references public.organizations(id) on delete cascade,
	rule_code text not null check (rule_code ~ '^[a-z][a-z0-9_.]{1,79}$'),
	rule_kind text not null check (rule_kind in ('categorise', 'withhold')),
	category_code text references public.report_activity_categories(code),
	reason_code text references public.report_disclosure_reasons(code),
	conditions jsonb not null default '[]'::jsonb,
	priority integer not null default 100,
	active boolean not null default true,
	description text,
	created_by uuid references public.user_profiles(id) on delete set null,
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now(),
	constraint report_disclosure_rules_client_needs_provider check (client_organization_id is null or provider_organization_id is not null),
	constraint report_disclosure_rules_kind_target check (
		(rule_kind = 'withhold' and reason_code is not null and category_code is null)
		or (rule_kind = 'categorise' and reason_code is null)
	),
	constraint report_disclosure_rules_conditions_valid check (public.report_rule_conditions_valid(conditions))
);
comment on table public.report_disclosure_rules is 'Ordered rules that categorise or withhold client activity report entries. provider_organization_id null = platform default; a provider (optionally for one client) overrides a platform rule by reusing its rule_code (set active=false to switch it off). categorise with category_code null keeps the default category. Facts: kind, event_type, module, service_line, category (withhold only), activity, subject, species, equipment, material, title, note, action, note_action, photos, videos, source, local_time.';
comment on column public.report_disclosure_rules.conditions is 'jsonb array of {field, operator: in|not_in|regex|not_regex|empty|non_empty|max|min, values|value, normalize: lower|letters|words}; all must hold.';

create unique index if not exists report_disclosure_rules_scope_code_key
	on public.report_disclosure_rules (
		coalesce(provider_organization_id, '00000000-0000-0000-0000-000000000000'::uuid),
		coalesce(client_organization_id, '00000000-0000-0000-0000-000000000000'::uuid),
		rule_code
	);
create index if not exists report_disclosure_rules_provider_idx on public.report_disclosure_rules (provider_organization_id);
create index if not exists report_disclosure_rules_client_idx on public.report_disclosure_rules (client_organization_id);
create index if not exists report_disclosure_rules_created_by_idx on public.report_disclosure_rules (created_by);

alter table public.report_activity_categories enable row level security;
alter table public.report_disclosure_reasons enable row level security;
alter table public.report_disclosure_rules enable row level security;

revoke all on table public.report_activity_categories from public, anon, authenticated;
revoke all on table public.report_disclosure_reasons from public, anon, authenticated;
revoke all on table public.report_disclosure_rules from public, anon, authenticated;
grant select on table public.report_activity_categories to authenticated;
grant select on table public.report_disclosure_reasons to authenticated;
grant select on table public.report_disclosure_rules to authenticated;

drop policy if exists report_activity_categories_select on public.report_activity_categories;
create policy report_activity_categories_select on public.report_activity_categories
	for select to authenticated using (true);
drop policy if exists report_disclosure_reasons_select on public.report_disclosure_reasons;
create policy report_disclosure_reasons_select on public.report_disclosure_reasons
	for select to authenticated using (true);
drop policy if exists report_disclosure_rules_select on public.report_disclosure_rules;
create policy report_disclosure_rules_select on public.report_disclosure_rules
	for select to authenticated
	using (provider_organization_id is null or public.is_tenant_import_admin(provider_organization_id));

insert into public.report_activity_categories (code, label, sort_order) values
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
on conflict (code) do nothing;

insert into public.report_disclosure_reasons (code, label_one, label_many, description, sort_order) values
	('travel_admin', 'travel, materials or administration record is', 'travel, materials and administration records are', 'How the work was run, not what happened at the place.', 10),
	('shift_marker', 'shift start or finish marker is', 'shift start and finish markers are', 'Officer movement markers.', 20),
	('routine_card', 'routine camera card swap is', 'routine camera card swaps are', 'A card swap with nothing found and no photo.', 30),
	('routine_check', 'routine status check (gate, lock or similar) is', 'routine status checks (gates, locks and similar) are', 'A status-only inspection with no finding, photo or action.', 40),
	('duplicate', 'duplicate entry is', 'duplicate entries are', 'The same entry recorded twice; reported once.', 90)
on conflict (code) do nothing;

insert into public.report_disclosure_rules (provider_organization_id, rule_code, rule_kind, category_code, reason_code, conditions, priority, description)
select null, r.rule_code, r.rule_kind, r.category_code, r.reason_code, r.conditions::jsonb, r.priority, r.description
from (values
	('category.card_review_camera', 'categorise', 'camera_activation', null,
		'[{"field":"kind","operator":"in","values":["event"]},{"field":"title","operator":"in","normalize":"letters","values":["cardreview"]}]',
		10, 'Every camera card review is a camera observation for the client (owner ruling 2026-11-05).'),
	('category.travel_activity_default', 'categorise', null, null,
		'[{"field":"activity","operator":"in","values":["travel","materials"]}]',
		20, 'Travel stays operational even when logged as a desk entry.'),
	('category.travel_title_default', 'categorise', null, null,
		'[{"field":"title","operator":"in","normalize":"letters","values":["travel"]}]',
		21, 'Travel stays operational even when logged as a desk entry.'),
	('category.admin_activity', 'categorise', 'administration', null,
		'[{"field":"activity","operator":"in","values":["administration"]}]',
		30, 'Administration activity.'),
	('category.admin_title', 'categorise', 'administration', null,
		'[{"field":"title","operator":"in","normalize":"letters","values":["admin","administration"]}]',
		31, 'Administration title.'),
	('category.patrol_log_desk_midnight', 'categorise', 'administration', null,
		'[{"field":"source","operator":"in","values":["rm_patrol_log_import"]},{"field":"local_time","operator":"in","values":["00:00"]}]',
		32, 'Patrol logs record desk work with a 0000 time, which imports as local midnight.'),
	('withhold.administration', 'withhold', null, 'travel_admin',
		'[{"field":"category","operator":"in","values":["administration","travel_admin"]}]',
		10, 'Administration and desk entries are withheld (owner ruling 2026-11-05).'),
	('withhold.travel_activity', 'withhold', null, 'travel_admin',
		'[{"field":"activity","operator":"in","values":["travel","administration","materials"]}]',
		11, 'Travel, administration and materials activity.'),
	('withhold.travel_title', 'withhold', null, 'travel_admin',
		'[{"field":"category","operator":"in","values":["patrol_visit","other_work","unclassified"]},{"field":"title","operator":"in","normalize":"letters","values":["travel","admin","administration"]}]',
		12, 'Travel or admin titled patrol entries.'),
	('withhold.shift_marker', 'withhold', null, 'shift_marker',
		'[{"field":"category","operator":"in","values":["patrol_visit","other_work","unclassified"]},{"field":"note","operator":"in","normalize":"letters","values":["start","finish","restart","home","enter","exit","startshift","finishshift","endshift","shiftstart","shiftend","shiftfinish","endofshift"]}]',
		20, 'Shift start, finish and movement markers.'),
	('withhold.routine_card', 'withhold', null, 'routine_card',
		'[{"field":"kind","operator":"in","values":["event","observation"]},{"field":"photos","operator":"max","value":0},{"field":"category","operator":"not_in","values":["incident"]},{"field":"title","operator":"in","normalize":"letters","values":["","card","cardreview","cardreplace","cardreplacement","cardchange","cardswap","replacecard"]},{"field":"note_action","operator":"regex","normalize":"words","value":"^((sd )?cards? (replaced|replace|swapped|swap|changed|change)|(replaced|replace|swapped|swap|changed|change|new) (sd )?cards?)( (replaced|swapped|changed))?$"}]',
		30, 'A card swap with nothing found is routine camera upkeep (owner ruling 2026-11-06).'),
	('withhold.routine_status_check', 'withhold', null, 'routine_check',
		'[{"field":"kind","operator":"in","values":["event"]},{"field":"category","operator":"in","values":["inspection"]},{"field":"photos","operator":"max","value":0},{"field":"videos","operator":"max","value":0},{"field":"action","operator":"empty"},{"field":"title","operator":"in","normalize":"letters","values":["open","closed","check","checked","gatecheck","locked","unlocked","secure","secured","live","dead","ok"]},{"field":"note","operator":"in","normalize":"letters","values":["","open","closed","check","checked","locked","secure","secured","live","dead","ok","working","closedandworking","openworking","provideaccessnolock","activeforest","nilvehicles","novehicles"]}]',
		40, 'A gate, lock or similar status check with no finding, photo or action is a non-event (owner ruling 2026-11-09).')
) as r(rule_code, rule_kind, category_code, reason_code, conditions, priority, description)
where not exists (
	select 1 from public.report_disclosure_rules e
	where e.provider_organization_id is null and e.client_organization_id is null and e.rule_code = r.rule_code
);

insert into public.bob_knowledge_cards (organization_id, category, key, title, content, tags, source)
select null, card.category, card.key, card.title, card.content, card.tags, 'migration:20261109150000_report_disclosure_rules'
from (values
	('report_disclosure', 'report_disclosure.rules', 'Client report disclosure rules: how to keep non-events out',
	 'What a client sees in an activity report is decided by rows in report_disclosure_rules, not code. Each rule has rule_kind categorise (sets the report category, or keeps the default when category_code is null) or withhold (keeps the entry out of the client report under a report_disclosure_reasons code; it is still counted in the provider completeness check). Conditions are a jsonb array, all must hold: {field, operator in|not_in|regex|not_regex|empty|non_empty|max|min, values or value, normalize lower|letters|words}. Facts: kind, event_type, module, service_line, category, activity, subject, species, equipment, material, title, note, action, note_action, photos, videos, source, local_time. Platform rules have no provider; a provider (optionally for one client) overrides one by reusing its rule_code, and active=false switches it off. Withhold only routine non-events: a status-only check (gate Open/Closed, lock Check, "Live", "Dead", "Secure", "Working") with no photo or action, shift markers, travel and desk work, card swaps with nothing found, exact duplicates. Never withhold an entry with a finding (damage, vehicles, people, access breaches), a photo, an action taken, or anything triaged as an incident. Propose a new rule with the evidence lines it would hide and the count it changes; the owner approves it.',
	 array['report', 'disclosure', 'rules', 'training'])
) as card(category, key, title, content, tags)
where not exists (
	select 1 from public.bob_knowledge_cards existing
	where existing.organization_id is null and existing.key = card.key
);

-- The body is otherwise the live definition of build_agreement_activity_report_core
-- (20261107212000_dispatch_attendance_in_activity_reports).
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
disclosure_rules as materialized (
	-- The most specific row per rule_code wins: provider+client, then provider, then platform.
	select r.rule_code, r.rule_kind, r.category_code, r.reason_code, r.conditions, r.priority
	from (
		select distinct on (r.rule_code) r.*
		from public.report_disclosure_rules r
		cross join agreement ag
		where (r.provider_organization_id is null or r.provider_organization_id = ag.provider_organization_id)
			and (r.client_organization_id is null or r.client_organization_id = ag.client_organization_id)
		order by r.rule_code,
			(r.client_organization_id is not null) desc,
			(r.provider_organization_id is not null) desc
	) r
	where r.active
),
acts_facts as materialized (
	select a.*,
		coalesce(pc.n, 0)::integer as photos, pc.refs as photo_refs, coalesce(iv.n, 0)::integer as videos,
		ml.materials as materials_used,
		coalesce(lower(btrim(coalesce(es.payload ->> 'patroller_raw', os.imported ->> 'patroller_raw'))), es.observed_entity_id::text, os.officer_id::text, '') as officer_key,
		jsonb_build_object(
			'kind', a.kind, 'event_type', a.event_type, 'module', a.module_key, 'service_line', a.service_line,
			'activity', a.activity, 'subject', a.subject, 'species', a.species, 'equipment', a.equipment, 'material', a.material,
			'title', a.title, 'note', a.note, 'action', a.action, 'note_action', concat_ws(' ', a.note, a.action),
			'photos', coalesce(pc.n, 0), 'videos', coalesce(iv.n, 0),
			'source', es.payload ->> 'source',
			'local_time', to_char(a.at at time zone 'Pacific/Auckland', 'HH24:MI')
		) as facts
	from acts_base a
	left join mat_lines ml on ml.record_id = a.record_id
	left join photo_counts pc on pc.record_id = a.record_id
	left join incident_videos iv on iv.record_id = a.record_id
	left join event_scope es on a.kind = 'event' and es.id = a.record_id
	left join observation_scope os on a.kind = 'observation' and os.id = a.record_id
),
acts_categorised as materialized (
	select f.*, c.category
	from acts_facts f
	left join lateral (
		select r.category_code
		from disclosure_rules r
		where r.rule_kind = 'categorise'
			and public.report_rule_conditions_match(r.conditions, f.facts)
		order by r.priority, r.rule_code
		limit 1
	) rc on true
	cross join lateral (
		select coalesce(rc.category_code, public.report_activity_category(f.kind, f.event_type, f.service_line, f.subject, f.activity, f.species, f.equipment, f.material)) as category
	) c
),
acts as materialized (
	select a.record_id, a.kind, a.at, (a.at at time zone 'Pacific/Auckland')::date as local_date,
		to_char(a.at at time zone 'Pacific/Auckland', 'HH24:MI') as local_time,
		a.place_name, a.module_key, a.event_type, a.service_line, a.subject, a.activity, a.species,
		a.equipment, a.material, a.job, a.work_order_status, a.title, a.note, a.action,
		a.incident_type, a.severity, a.incident_status, a.investigation_ref, a.investigation_status,
		a.photos, a.photo_refs, a.videos, a.materials_used, a.category,
		-- Withholding vocabulary lives in report_disclosure_rules (data, not code).
		-- An exact repeat of another entry is a structural check: same local minute,
		-- place, officer, title, comment and action; the copy with most photos is kept.
		coalesce(wr.reason_code,
			case when a.kind in ('event', 'observation')
				and row_number() over (
					partition by a.kind in ('event', 'observation'),
						date_trunc('minute', a.at at time zone 'Pacific/Auckland'),
						lower(coalesce(a.place_name, '')),
						a.officer_key,
						lower(btrim(regexp_replace(coalesce(a.title, ''), '\s+', ' ', 'g'))),
						lower(btrim(regexp_replace(coalesce(a.note, ''), '\s+', ' ', 'g'))),
						lower(btrim(regexp_replace(coalesce(a.action, ''), '\s+', ' ', 'g')))
					order by a.photos desc, a.at, a.record_id::text
				) > 1
				then 'duplicate'
			end) as withheld_reason
	from acts_categorised a
	left join lateral (
		select r.reason_code
		from disclosure_rules r
		where r.rule_kind = 'withhold'
			and public.report_rule_conditions_match(r.conditions, a.facts || jsonb_build_object('category', a.category))
		order by r.priority, r.rule_code
		limit 1
	) wr on true
),
vis as materialized (
	select * from acts where withheld_reason is null
),
category_catalog as (
	select c.code, c.label, c.sort_order
	from public.report_activity_categories c
	where c.is_active
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
		(select count(*) filter (where withheld_reason = 'duplicate') from acts) as withheld_duplicates,
		(select count(*) filter (where withheld_reason is not null) from acts) as withheld_total
),
withheld_reasons as (
	select a.withheld_reason as code, count(*) as entries
	from acts a
	where a.withheld_reason is not null
	group by a.withheld_reason
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
			'operationalWithheld', sc.withheld_total,
			'withheldByReason', coalesce((
				select jsonb_agg(jsonb_build_object(
					'code', w.code, 'entries', w.entries,
					'labelOne', coalesce(r.label_one, replace(w.code, '_', ' ') || ' entry is'),
					'labelMany', coalesce(r.label_many, replace(w.code, '_', ' ') || ' entries are')
				) order by coalesce(r.sort_order, 1000), w.code)
				from withheld_reasons w
				left join public.report_disclosure_reasons r on r.code = w.code
			), '[]'::jsonb),
			'withheldTravelAdmin', sc.withheld_travel_admin,
			'withheldShiftMarkers', sc.withheld_shift_markers,
			'withheldRoutineCards', sc.withheld_routine_cards,
			'withheldDuplicates', sc.withheld_duplicates,
			'itemised', (select count(*) from line_rows),
			'notItemised', t.entries - (select count(*) from line_rows),
			'unclassified', coalesce((select ct.entries from category_totals ct where ct.category = 'unclassified'), 0),
			'reconciled', (
				sc.all_entries = (sc.events_in_scope - sc.mirrors) + sc.observations_in_scope + sc.work_orders_in_scope + sc.incidents_in_scope
				and sc.all_entries = t.entries + sc.withheld_total
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

revoke all on function public.build_agreement_activity_report_core(uuid, timestamp with time zone, timestamp with time zone, integer) from public, anon, authenticated, service_role;
grant execute on function public.build_agreement_activity_report_core(uuid, timestamp with time zone, timestamp with time zone, integer) to postgres;
revoke all on function public.report_rule_conditions_match(jsonb, jsonb) from public, anon;
revoke all on function public.report_rule_conditions_valid(jsonb) from public, anon;
grant execute on function public.report_rule_conditions_match(jsonb, jsonb) to authenticated, service_role;
grant execute on function public.report_rule_conditions_valid(jsonb) to authenticated, service_role;
