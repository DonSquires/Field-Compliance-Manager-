-- Base44 RAMS (OFO) read-only mirror: hunter kill/nil returns and permit holders, plus the
-- hunter-return summary in the client site activity report.
--
-- Base44 stays the system of record. scripts/sync-base44-rams.mjs reads it with a dedicated
-- read-only token and hands normalised rows to the two server-only ingest RPCs below. Client
-- reports only ever see species and hunting-area totals; hunter names, emails and comments
-- remain provider-private.

create table public.hunter_kill_returns (
	id uuid primary key default gen_random_uuid(),
	organization_id uuid not null references public.organizations(id) on delete cascade,
	client_organization_id uuid not null references public.organizations(id) on delete cascade,
	source_system text not null default 'base44_rams' check (source_system = 'base44_rams'),
	source_id text not null check (source_id ~ '^[A-Za-z0-9_-]{6,64}$'),
	source_booking_id text,
	permit_number text,
	person_permit_id uuid references public.person_permits(id) on delete set null,
	hunting_area text not null check (length(hunting_area) between 1 and 200),
	hunt_date date not null,
	return_type text not null check (return_type in ('kill', 'nil')),
	animals jsonb not null default '[]'::jsonb check (jsonb_typeof(animals) = 'array'),
	total_animals integer not null default 0 check (total_animals >= 0),
	comments text,
	hunter_name text,
	hunter_email text,
	source_created_at timestamptz,
	source_updated_at timestamptz,
	synced_at timestamptz not null default now(),
	withdrawn_at timestamptz,
	unique (source_system, source_id),
	check (return_type = 'kill' or total_animals = 0)
);

comment on table public.hunter_kill_returns is 'Read-only mirror of hunter kill and nil returns from the Base44 RAMS (OFO) app. Base44 is the system of record; rows are written only by ingest_base44_rams_kill_returns. Hunter name, email and comments are provider-private and never reach client reports, which only show species and hunting-area totals.';
comment on column public.hunter_kill_returns.animals is 'Normalised [{species, count}] as reported by the hunter. Counts are animals the hunter reported, not population estimates.';
comment on column public.hunter_kill_returns.withdrawn_at is 'Set when a complete sync no longer finds the return in Base44 (deleted at source). Withdrawn returns are excluded from reports.';
comment on column public.hunter_kill_returns.hunter_name is 'Personal information. Provider-private; never copied into client reports.';
comment on column public.hunter_kill_returns.hunter_email is 'Personal information. Provider-private; never copied into client reports.';

create index hunter_kill_returns_client_date_idx on public.hunter_kill_returns (organization_id, client_organization_id, hunt_date) where withdrawn_at is null;
create index hunter_kill_returns_permit_idx on public.hunter_kill_returns (person_permit_id) where person_permit_id is not null;

alter table public.hunter_kill_returns enable row level security;
revoke all on table public.hunter_kill_returns from public, anon, authenticated;
grant select on table public.hunter_kill_returns to authenticated;
grant all on table public.hunter_kill_returns to service_role;
create policy hunter_kill_returns_provider_admin_read on public.hunter_kill_returns
	for select to authenticated
	using (public.is_admin_for_org(organization_id));

create or replace function public.ingest_base44_rams_kill_returns(
	p_provider_organization_id uuid,
	p_rows jsonb,
	p_seen_source_ids text[] default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog'
as $function$
declare
	v_inserted integer := 0;
	v_updated integer := 0;
	v_rejected integer := 0;
	v_withdrawn integer := 0;
	v_clients uuid[];
begin
	if p_provider_organization_id is null
		or not exists (select 1 from public.organizations o where o.id = p_provider_organization_id) then
		raise exception 'unknown provider organization' using errcode = '22023';
	end if;
	if jsonb_typeof(coalesce(p_rows, '[]'::jsonb)) <> 'array' then
		raise exception 'p_rows must be a JSON array' using errcode = '22023';
	end if;

	with raw as (
		select r,
			nullif(btrim(r ->> 'source_id'), '') as source_id,
			case when (r ->> 'client_organization_id') ~* '^[0-9a-f-]{36}$' then (r ->> 'client_organization_id')::uuid end as client_id,
			case when (r ->> 'hunt_date') ~ '^\d{4}-\d{2}-\d{2}$' then (r ->> 'hunt_date')::date end as hunt_date,
			lower(btrim(r ->> 'return_type')) as return_type,
			left(nullif(btrim(r ->> 'hunting_area'), ''), 200) as hunting_area
		from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r
	),
	valid as (
		select raw.*,
			coalesce((
				select jsonb_agg(jsonb_build_object('species', a.species, 'count', a.n) order by a.species)
				from (
					select left(btrim(x ->> 'species'), 60) as species, sum(least(greatest((x ->> 'count')::integer, 0), 1000))::integer as n
					from jsonb_array_elements(case when jsonb_typeof(raw.r -> 'animals') = 'array' then raw.r -> 'animals' else '[]'::jsonb end) x
					where raw.return_type = 'kill'
						and nullif(btrim(x ->> 'species'), '') is not null
						and (x ->> 'count') ~ '^\d{1,6}$'
					group by 1
				) a where a.n > 0
			), '[]'::jsonb) as animals
		from raw
		where raw.source_id ~ '^[A-Za-z0-9_-]{6,64}$'
			and raw.client_id is not null
			and exists (select 1 from public.organizations o where o.id = raw.client_id)
			and raw.hunt_date is not null
			and raw.return_type in ('kill', 'nil')
			and raw.hunting_area is not null
	),
	shaped as (
		select v.source_id, v.client_id, v.hunt_date, v.return_type, v.hunting_area, v.animals,
			(select coalesce(sum((a ->> 'count')::integer), 0) from jsonb_array_elements(v.animals) a)::integer as total_animals,
			left(nullif(btrim(v.r ->> 'booking_id'), ''), 64) as booking_id,
			left(nullif(btrim(v.r ->> 'permit_number'), ''), 64) as permit_number,
			left(nullif(btrim(v.r ->> 'comments'), ''), 2000) as comments,
			left(nullif(btrim(v.r ->> 'hunter_name'), ''), 200) as hunter_name,
			left(nullif(lower(btrim(v.r ->> 'hunter_email')), ''), 254) as hunter_email,
			case when (v.r ->> 'source_created_at') ~ '^\d{4}-\d{2}-\d{2}T' then (v.r ->> 'source_created_at')::timestamptz end as source_created_at,
			case when (v.r ->> 'source_updated_at') ~ '^\d{4}-\d{2}-\d{2}T' then (v.r ->> 'source_updated_at')::timestamptz end as source_updated_at
		from valid v
	),
	upserted as (
		insert into public.hunter_kill_returns as h (
			organization_id, client_organization_id, source_id, source_booking_id, permit_number, person_permit_id,
			hunting_area, hunt_date, return_type, animals, total_animals, comments, hunter_name, hunter_email,
			source_created_at, source_updated_at, synced_at, withdrawn_at
		)
		select p_provider_organization_id, s.client_id, s.source_id, s.booking_id, s.permit_number,
			(select pp.id from public.person_permits pp where pp.organization_id = p_provider_organization_id and pp.permit_number = s.permit_number),
			s.hunting_area, s.hunt_date, s.return_type, s.animals, s.total_animals, s.comments, s.hunter_name, s.hunter_email,
			s.source_created_at, s.source_updated_at, now(), null
		from shaped s
		on conflict (source_system, source_id) do update set
			client_organization_id = excluded.client_organization_id,
			source_booking_id = excluded.source_booking_id,
			permit_number = excluded.permit_number,
			person_permit_id = excluded.person_permit_id,
			hunting_area = excluded.hunting_area,
			hunt_date = excluded.hunt_date,
			return_type = excluded.return_type,
			animals = excluded.animals,
			total_animals = excluded.total_animals,
			comments = excluded.comments,
			hunter_name = excluded.hunter_name,
			hunter_email = excluded.hunter_email,
			source_created_at = excluded.source_created_at,
			source_updated_at = excluded.source_updated_at,
			synced_at = now(),
			withdrawn_at = null
		where h.organization_id = p_provider_organization_id
			and (h.withdrawn_at is not null
				or (h.client_organization_id, h.source_booking_id, h.permit_number, h.person_permit_id, h.hunting_area, h.hunt_date,
					h.return_type, h.animals, h.comments, h.hunter_name, h.hunter_email, h.source_updated_at)
				is distinct from
				(excluded.client_organization_id, excluded.source_booking_id, excluded.permit_number, excluded.person_permit_id,
					excluded.hunting_area, excluded.hunt_date, excluded.return_type, excluded.animals, excluded.comments,
					excluded.hunter_name, excluded.hunter_email, excluded.source_updated_at))
		returning (h.xmax = 0) as inserted
	)
	select count(*) filter (where inserted), count(*) filter (where not inserted)
	into v_inserted, v_updated
	from upserted;

	v_rejected := jsonb_array_length(coalesce(p_rows, '[]'::jsonb)) - (
		select count(*) from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r
		where exists (
			select 1 from public.hunter_kill_returns h
			where h.source_system = 'base44_rams' and h.source_id = btrim(r ->> 'source_id')
				and h.organization_id = p_provider_organization_id and h.withdrawn_at is null
		)
	);

	if p_seen_source_ids is not null then
		if cardinality(p_seen_source_ids) = 0 then
			raise exception 'refusing to withdraw every return from an empty source listing' using errcode = '22023';
		end if;
		update public.hunter_kill_returns h
		set withdrawn_at = now()
		where h.organization_id = p_provider_organization_id
			and h.source_system = 'base44_rams'
			and h.withdrawn_at is null
			and not (h.source_id = any (p_seen_source_ids));
		get diagnostics v_withdrawn = row_count;
	end if;

	select coalesce(array_agg(distinct h.client_organization_id), '{}') into v_clients
	from public.hunter_kill_returns h where h.organization_id = p_provider_organization_id;

	insert into public.audit_log (organization_id, action, target_table, metadata)
	values (p_provider_organization_id, 'sync_base44_rams_kill_returns', 'hunter_kill_returns', jsonb_build_object(
		'source', 'base44_rams', 'received', jsonb_array_length(coalesce(p_rows, '[]'::jsonb)),
		'inserted', v_inserted, 'updated', v_updated, 'rejected', v_rejected, 'withdrawn', v_withdrawn,
		'complete_listing', p_seen_source_ids is not null));

	return jsonb_build_object('inserted', v_inserted, 'updated', v_updated, 'rejected', v_rejected,
		'withdrawn', v_withdrawn, 'clients', to_jsonb(v_clients));
end;
$function$;

comment on function public.ingest_base44_rams_kill_returns(uuid, jsonb, text[]) is 'Server-only upsert of hunter kill/nil returns read from the Base44 RAMS (OFO) app. Idempotent on (source_system, source_id); rows failing validation are counted as rejected. When p_seen_source_ids carries the complete Base44 listing, returns no longer present are marked withdrawn (never deleted). Writes one audit_log entry per call.';
revoke all on function public.ingest_base44_rams_kill_returns(uuid, jsonb, text[]) from public, anon, authenticated;
grant execute on function public.ingest_base44_rams_kill_returns(uuid, jsonb, text[]) to service_role;

create or replace function public.ingest_base44_rams_permits(
	p_provider_organization_id uuid,
	p_rows jsonb
)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog'
as $function$
declare
	r jsonb;
	v jsonb;
	v_client uuid;
	v_permit_number text;
	v_holder text;
	v_normalized text;
	v_user_id text;
	v_person uuid;
	v_matches integer;
	v_permit uuid;
	v_vehicle uuid;
	v_plate text;
	v_status text;
	v_expiry date;
	v_created integer := 0;
	v_updated integer := 0;
	v_rejected integer := 0;
	v_people_created integer := 0;
	v_people_review integer := 0;
	v_vehicles_linked integer := 0;
	v_rows integer;
begin
	if p_provider_organization_id is null
		or not exists (select 1 from public.organizations o where o.id = p_provider_organization_id) then
		raise exception 'unknown provider organization' using errcode = '22023';
	end if;
	if jsonb_typeof(coalesce(p_rows, '[]'::jsonb)) <> 'array' then
		raise exception 'p_rows must be a JSON array' using errcode = '22023';
	end if;

	for r in select x from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) x loop
		v_permit_number := left(nullif(btrim(r ->> 'permit_number'), ''), 64);
		v_holder := left(nullif(regexp_replace(btrim(coalesce(r ->> 'holder_name', '')), '\s+', ' ', 'g'), ''), 200);
		v_user_id := nullif(btrim(r ->> 'source_user_id'), '');
		v_client := case when (r ->> 'client_organization_id') ~* '^[0-9a-f-]{36}$' then (r ->> 'client_organization_id')::uuid end;
		v_status := lower(btrim(coalesce(r ->> 'status', '')));
		v_expiry := case when (r ->> 'expiry_date') ~ '^\d{4}-\d{2}-\d{2}$' then (r ->> 'expiry_date')::date end;
		if v_permit_number is null or v_holder is null or v_client is null
			or v_user_id is null or v_user_id !~ '^[A-Za-z0-9_-]{6,64}$'
			or v_status not in ('active', 'expired', 'revoked', 'suspended')
			or not exists (select 1 from public.organizations o where o.id = v_client) then
			v_rejected := v_rejected + 1;
			continue;
		end if;

		select pp.id into v_permit
		from public.person_permits pp
		where pp.organization_id = p_provider_organization_id and pp.permit_number = v_permit_number;

		if v_permit is null then
			v_normalized := lower(v_holder);
			select count(*), min(cp.id::text)::uuid into v_matches, v_person
			from public.canonical_people cp
			where cp.normalized_name = v_normalized and cp.status = 'active';
			if v_matches <> 1 then
				insert into public.canonical_people (canonical_key, display_name, normalized_name, review_state, status, metadata)
				values ('person:base44:' || v_user_id, v_holder, v_normalized,
					case when v_matches > 1 then 'manual_review_required' else 'draft' end, 'active',
					jsonb_build_object('source', 'base44_rams', 'name_matches', v_matches))
				on conflict (canonical_key) do nothing
				returning id into v_person;
				if v_person is null then
					select cp.id into v_person from public.canonical_people cp where cp.canonical_key = 'person:base44:' || v_user_id;
				else
					v_people_created := v_people_created + 1;
					if v_matches > 1 then v_people_review := v_people_review + 1; end if;
				end if;
			end if;

			insert into public.person_permits (
				organization_id, client_organization_id, canonical_person_id, permit_number, permit_type, applicant_type,
				company_name, activities, date_to, firearm_confirm, firearm_licence_valid, status, contact_email, contact_phone,
				compliance_checked_at, compliance_source, source_document
			) values (
				p_provider_organization_id, v_client, v_person, v_permit_number,
				left(nullif(btrim(r ->> 'permit_type'), ''), 120), left(nullif(btrim(r ->> 'applicant_type'), ''), 120),
				left(nullif(btrim(r ->> 'company_name'), ''), 200),
				(select nullif(array_agg(left(btrim(a), 80) order by ord), '{}') from jsonb_array_elements_text(
					case when jsonb_typeof(r -> 'activities') = 'array' then r -> 'activities' else '[]'::jsonb end) with ordinality t(a, ord)
					where nullif(btrim(a), '') is not null),
				v_expiry,
				case when jsonb_typeof(r -> 'firearms_permitted') = 'boolean' then (r ->> 'firearms_permitted')::boolean end,
				case when jsonb_typeof(r -> 'firearm_licence_valid') = 'boolean' then (r ->> 'firearm_licence_valid')::boolean end,
				v_status, left(nullif(lower(btrim(r ->> 'contact_email')), ''), 254), left(nullif(btrim(r ->> 'contact_phone'), ''), 40),
				now(), 'import', 'Base44 RAMS (OFO)'
			) returning id into v_permit;
			v_created := v_created + 1;
		else
			update public.person_permits pp set
				client_organization_id = v_client,
				permit_type = coalesce(left(nullif(btrim(r ->> 'permit_type'), ''), 120), pp.permit_type),
				applicant_type = coalesce(left(nullif(btrim(r ->> 'applicant_type'), ''), 120), pp.applicant_type),
				company_name = coalesce(left(nullif(btrim(r ->> 'company_name'), ''), 200), pp.company_name),
				activities = coalesce((select nullif(array_agg(left(btrim(a), 80) order by ord), '{}') from jsonb_array_elements_text(
					case when jsonb_typeof(r -> 'activities') = 'array' then r -> 'activities' else '[]'::jsonb end) with ordinality t(a, ord)
					where nullif(btrim(a), '') is not null), pp.activities),
				date_to = coalesce(v_expiry, pp.date_to),
				firearm_confirm = coalesce(case when jsonb_typeof(r -> 'firearms_permitted') = 'boolean' then (r ->> 'firearms_permitted')::boolean end, pp.firearm_confirm),
				firearm_licence_valid = coalesce(case when jsonb_typeof(r -> 'firearm_licence_valid') = 'boolean' then (r ->> 'firearm_licence_valid')::boolean end, pp.firearm_licence_valid),
				status = v_status,
				contact_email = coalesce(left(nullif(lower(btrim(r ->> 'contact_email')), ''), 254), pp.contact_email),
				contact_phone = coalesce(left(nullif(btrim(r ->> 'contact_phone'), ''), 40), pp.contact_phone),
				compliance_checked_at = now(),
				compliance_source = 'import',
				source_document = 'Base44 RAMS (OFO)',
				updated_at = now()
			where pp.id = v_permit;
			v_updated := v_updated + 1;
		end if;

		for v in select x from jsonb_array_elements(case when jsonb_typeof(r -> 'vehicles') = 'array' then r -> 'vehicles' else '[]'::jsonb end) x loop
			v_plate := upper(regexp_replace(coalesce(v ->> 'plate', ''), '[^A-Za-z0-9]', '', 'g'));
			continue when v_plate !~ '^[A-Z0-9]{2,8}$';
			insert into public.canonical_vehicles (plate_number, make, model, colour, compliance_source, compliance_checked_at)
			values (v_plate, left(nullif(btrim(v ->> 'make'), ''), 60), left(nullif(btrim(v ->> 'model'), ''), 60),
				left(nullif(btrim(v ->> 'colour'), ''), 40), 'canonical', now())
			on conflict (plate_number) do update set
				make = coalesce(public.canonical_vehicles.make, excluded.make),
				model = coalesce(public.canonical_vehicles.model, excluded.model),
				colour = coalesce(public.canonical_vehicles.colour, excluded.colour)
			returning id into v_vehicle;
			insert into public.person_permit_vehicles (organization_id, permit_id, canonical_vehicle_id)
			values (p_provider_organization_id, v_permit, v_vehicle)
			on conflict (permit_id, canonical_vehicle_id) do nothing;
			get diagnostics v_rows = row_count;
			v_vehicles_linked := v_vehicles_linked + v_rows;
		end loop;
		v_permit := null;
		v_person := null;
	end loop;

	update public.hunter_kill_returns h
	set person_permit_id = pp.id
	from public.person_permits pp
	where h.organization_id = p_provider_organization_id
		and pp.organization_id = p_provider_organization_id
		and pp.permit_number = h.permit_number
		and h.person_permit_id is distinct from pp.id;

	insert into public.audit_log (organization_id, action, target_table, metadata)
	values (p_provider_organization_id, 'sync_base44_rams_permits', 'person_permits', jsonb_build_object(
		'source', 'base44_rams', 'received', jsonb_array_length(coalesce(p_rows, '[]'::jsonb)),
		'created', v_created, 'updated', v_updated, 'rejected', v_rejected,
		'people_created', v_people_created, 'people_needing_review', v_people_review, 'vehicles_linked', v_vehicles_linked));

	return jsonb_build_object('created', v_created, 'updated', v_updated, 'rejected', v_rejected,
		'people_created', v_people_created, 'people_needing_review', v_people_review, 'vehicles_linked', v_vehicles_linked);
end;
$function$;

comment on function public.ingest_base44_rams_permits(uuid, jsonb) is 'Server-only upsert of RAMS permits read from Base44 into person_permits (idempotent on organization_id, permit_number), with holder identity matched by exact normalised name (ambiguous names create a manual-review draft keyed by the Base44 user id) and permit vehicles linked through canonical_vehicles. Existing permits keep their linked person. Writes one audit_log entry per call.';
revoke all on function public.ingest_base44_rams_permits(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.ingest_base44_rams_permits(uuid, jsonb) to service_role;

-- The full activity assembler keeps its body; the public name becomes a thin wrapper that adds the
-- hunter-return summary. Future changes to the assembler belong in build_agreement_activity_report_core.
alter function public.build_agreement_activity_report(uuid, timestamptz, timestamptz, integer)
	rename to build_agreement_activity_report_core;
revoke all on function public.build_agreement_activity_report_core(uuid, timestamptz, timestamptz, integer) from public, anon, authenticated, service_role;
grant execute on function public.build_agreement_activity_report_core(uuid, timestamptz, timestamptz, integer) to postgres;

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
core as (
	select public.build_agreement_activity_report_core(p_service_agreement_id, p_from, p_to, p_max_lines) as j
),
agreement as (
	select a.provider_organization_id, a.client_organization_id
	from public.service_agreements a
	where a.id = p_service_agreement_id
),
client_returns as (
	select h.hunting_area, h.return_type, h.animals, h.total_animals, h.hunt_date
	from public.hunter_kill_returns h
	join agreement a on h.organization_id = a.provider_organization_id and h.client_organization_id = a.client_organization_id
	where h.withdrawn_at is null
),
in_window as (
	select c.*
	from client_returns c
	where (c.hunt_date::timestamp at time zone 'Pacific/Auckland') >= p_from
		and (c.hunt_date::timestamp at time zone 'Pacific/Auckland') < p_to
),
species as (
	select a ->> 'species' as species, sum((a ->> 'count')::integer)::integer as animals, count(*)::integer as returns
	from in_window w
	cross join lateral jsonb_array_elements(w.animals) a
	group by 1
),
areas as (
	select w.hunting_area as area, count(*)::integer as returns,
		count(*) filter (where w.return_type = 'kill')::integer as kill,
		count(*) filter (where w.return_type = 'nil')::integer as nil,
		sum(w.total_animals)::integer as animals
	from in_window w
	group by 1
),
summary as (
	select jsonb_build_object(
		'source', 'Hunter-submitted returns (RAMS)',
		'returns', (select count(*) from in_window),
		'killReturns', (select count(*) from in_window where return_type = 'kill'),
		'nilReturns', (select count(*) from in_window where return_type = 'nil'),
		'animals', (select coalesce(sum(total_animals), 0) from in_window),
		'bySpecies', coalesce((select jsonb_agg(jsonb_build_object('species', s.species, 'animals', s.animals, 'returns', s.returns)
			order by s.animals desc, s.species) from species s), '[]'::jsonb),
		'byArea', coalesce((select jsonb_agg(jsonb_build_object('area', ar.area, 'returns', ar.returns, 'kill', ar.kill, 'nil', ar.nil, 'animals', ar.animals)
			order by ar.animals desc, ar.returns desc, ar.area) from areas ar), '[]'::jsonb)
	) as s
)
select case
	when core.j -> 'report' is null or not exists (select 1 from client_returns) then core.j
	else jsonb_set(core.j, '{report,hunterReturns}', (select s from summary))
end
from core;
$function$;

comment on function public.build_agreement_activity_report(uuid, timestamptz, timestamptz, integer) is 'Internal assembler for the R&M month-end site activity report. Wraps build_agreement_activity_report_core and, for clients with Base44 RAMS hunter returns, adds report.hunterReturns: return counts and animals by species and hunting area for hunt dates in the window (Pacific/Auckland). Hunter names, emails, permits and comments are never copied. Auth is on generate_due_report_packs and get_report_pack_activity_accounting.';
revoke all on function public.build_agreement_activity_report(uuid, timestamptz, timestamptz, integer) from public, anon, authenticated, service_role;
grant execute on function public.build_agreement_activity_report(uuid, timestamptz, timestamptz, integer) to postgres;
