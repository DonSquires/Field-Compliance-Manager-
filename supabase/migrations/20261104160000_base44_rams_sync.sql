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

-- RAMS person and vehicle enrichment. canonical_people and canonical_vehicles are the shared
-- identity spine, so only blank Tier 0 attributes are filled there. Everything RAMS records about
-- a person (contact, address, date of birth, firearms licence, vehicles and insurance, hunting
-- companions) is held provider-private below and linked back to the canonical records.

create table public.rams_person_profiles (
	id uuid primary key default gen_random_uuid(),
	organization_id uuid not null references public.organizations(id) on delete cascade,
	canonical_person_id uuid not null references public.canonical_people(id) on delete restrict,
	source_system text not null default 'base44_rams' check (source_system = 'base44_rams'),
	source_user_id text not null check (source_user_id ~ '^[A-Za-z0-9_-]{6,64}$'),
	source_url text not null,
	full_name text not null,
	legal_name text,
	nickname text,
	email text,
	phone text,
	home_address text,
	date_of_birth date,
	firearms_licence_number text,
	firearms_licence_expiry date,
	firearms_licence_status text,
	firearms_licence_document_url text,
	account_role text,
	admin_level text,
	is_verified boolean,
	client_organization_ids uuid[] not null default '{}',
	source_created_at timestamptz,
	source_updated_at timestamptz,
	synced_at timestamptz not null default now(),
	unique (source_system, source_user_id)
);

comment on table public.rams_person_profiles is 'Provider-private mirror of the person details recorded in the Base44 RAMS (OFO) app, linked to the canonical person (and through canonical_person_links). Base44 is the system of record; rows are written only by ingest_base44_rams_people. Contains personal information (address, date of birth, firearms licence); never copied into client reports.';
comment on column public.rams_person_profiles.source_url is 'Where the record lives in Base44 RAMS; pair with source_user_id to open it.';

create index rams_person_profiles_person_idx on public.rams_person_profiles (canonical_person_id);
create index rams_person_profiles_org_email_idx on public.rams_person_profiles (organization_id, email) where email is not null;

create table public.rams_person_vehicles (
	id uuid primary key default gen_random_uuid(),
	organization_id uuid not null references public.organizations(id) on delete cascade,
	rams_person_profile_id uuid not null references public.rams_person_profiles(id) on delete cascade,
	canonical_person_id uuid not null references public.canonical_people(id) on delete restrict,
	canonical_vehicle_id uuid not null references public.canonical_vehicles(id) on delete restrict,
	plate_as_recorded text not null,
	make text,
	model text,
	colour text,
	insurance_expiry date,
	company_insurance boolean,
	company_insurance_comments text,
	insurance_document_urls text[] not null default '{}',
	vehicle_status text,
	archived boolean,
	synced_at timestamptz not null default now(),
	withdrawn_at timestamptz,
	unique (rams_person_profile_id, canonical_vehicle_id)
);

comment on table public.rams_person_vehicles is 'Provider-private link between a canonical person and a canonical vehicle as registered by that person in Base44 RAMS, with the insurance and status details RAMS holds. Withdrawn when the vehicle leaves the person''s RAMS profile.';

create index rams_person_vehicles_vehicle_idx on public.rams_person_vehicles (canonical_vehicle_id);
create index rams_person_vehicles_person_idx on public.rams_person_vehicles (canonical_person_id);

create table public.rams_person_associations (
	id uuid primary key default gen_random_uuid(),
	organization_id uuid not null references public.organizations(id) on delete cascade,
	client_organization_id uuid references public.organizations(id) on delete set null,
	canonical_person_id uuid not null references public.canonical_people(id) on delete restrict,
	associated_canonical_person_id uuid not null references public.canonical_people(id) on delete restrict,
	relationship text not null default 'hunting_companion' check (relationship = 'hunting_companion'),
	source_system text not null default 'base44_rams' check (source_system = 'base44_rams'),
	holder_source_user_id text not null,
	companion_name text not null,
	companion_email text,
	companion_phone text,
	permitted_status text,
	booking_count integer not null default 0 check (booking_count >= 0),
	first_booking_date date,
	last_booking_date date,
	last_hunting_area text,
	synced_at timestamptz not null default now(),
	unique (organization_id, canonical_person_id, associated_canonical_person_id, relationship),
	check (canonical_person_id <> associated_canonical_person_id)
);

comment on table public.rams_person_associations is 'Provider-private record of the people a RAMS permit holder names as hunting companions on Base44 bookings, linked to canonical people on both sides. Written only by ingest_base44_rams_companions.';

create index rams_person_associations_associated_idx on public.rams_person_associations (associated_canonical_person_id);

alter table public.rams_person_profiles enable row level security;
alter table public.rams_person_vehicles enable row level security;
alter table public.rams_person_associations enable row level security;
revoke all on table public.rams_person_profiles, public.rams_person_vehicles, public.rams_person_associations from public, anon, authenticated;
grant select on table public.rams_person_profiles, public.rams_person_vehicles, public.rams_person_associations to authenticated;
grant all on table public.rams_person_profiles, public.rams_person_vehicles, public.rams_person_associations to service_role;
create policy rams_person_profiles_provider_admin_read on public.rams_person_profiles
	for select to authenticated using (public.is_admin_for_org(organization_id));
create policy rams_person_vehicles_provider_admin_read on public.rams_person_vehicles
	for select to authenticated using (public.is_admin_for_org(organization_id));
create policy rams_person_associations_provider_admin_read on public.rams_person_associations
	for select to authenticated using (public.is_admin_for_org(organization_id));

-- Internal: find or create the canonical person for a RAMS identity. Order: an existing record
-- under the stable canonical key; then the provider's own records matched on email AND
-- normalised name (the permit-import rule); otherwise a draft keyed to the RAMS identity, flagged
-- for manual review when someone of the same name already exists. Never matches on name alone.
create or replace function public.base44_rams_resolve_person(
	p_provider_organization_id uuid,
	p_canonical_key text,
	p_name text,
	p_email text,
	out person_id uuid,
	out created boolean,
	out needs_review boolean
)
language plpgsql
security definer
set search_path to 'pg_catalog'
as $function$
declare
	v_norm text := public.normalize_person_name(p_name);
	v_email text := nullif(lower(btrim(p_email)), '');
	v_candidates uuid[];
	v_same_name boolean;
begin
	created := false;
	needs_review := false;

	select coalesce(cp.merged_into_id, cp.id) into person_id
	from public.canonical_people cp where cp.canonical_key = p_canonical_key;
	if person_id is not null then
		return;
	end if;

	if v_email is not null and v_norm is not null then
		select array_agg(distinct p.id) into v_candidates
		from (
			select pp.canonical_person_id as id
			from public.person_permits pp
			where pp.organization_id = p_provider_organization_id and lower(btrim(pp.contact_email)) = v_email
			union
			select rp.canonical_person_id
			from public.rams_person_profiles rp
			where rp.organization_id = p_provider_organization_id and rp.email = v_email
		) m
		join public.canonical_people p on p.id = m.id
		where p.status = 'active' and p.merged_into_id is null
			and public.normalize_person_name(p.display_name) = v_norm;
		if cardinality(v_candidates) = 1 then
			person_id := v_candidates[1];
			return;
		end if;
	end if;

	select exists (
		select 1 from public.canonical_people p
		where p.normalized_name = v_norm and p.status = 'active' and p.merged_into_id is null
	) into v_same_name;

	insert into public.canonical_people (canonical_key, display_name, normalized_name, review_state, status, metadata)
	values (p_canonical_key, p_name, coalesce(v_norm, ''),
		case when v_same_name then 'manual_review_required' else 'draft' end, 'active',
		jsonb_build_object('source', 'base44_rams', 'possible_duplicate_name', v_same_name))
	on conflict (canonical_key) do nothing
	returning id into person_id;
	if person_id is null then
		select coalesce(cp.merged_into_id, cp.id) into person_id from public.canonical_people cp where cp.canonical_key = p_canonical_key;
	else
		created := true;
		needs_review := v_same_name;
	end if;
end;
$function$;

revoke all on function public.base44_rams_resolve_person(uuid, text, text, text) from public, anon, authenticated;

create or replace function public.ingest_base44_rams_people(
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
	v_user_id text;
	v_name text;
	v_email text;
	v_dob date;
	v_person uuid;
	v_profile uuid;
	v_vehicle uuid;
	v_plate text;
	v_vehicle_ids uuid[];
	v_resolved record;
	v_inserted boolean;
	v_rows integer;
	v_profiles_created integer := 0;
	v_profiles_updated integer := 0;
	v_people_created integer := 0;
	v_people_review integer := 0;
	v_people_enriched integer := 0;
	v_vehicles_linked integer := 0;
	v_vehicles_withdrawn integer := 0;
	v_rejected integer := 0;
begin
	if p_provider_organization_id is null
		or not exists (select 1 from public.organizations o where o.id = p_provider_organization_id) then
		raise exception 'unknown provider organization' using errcode = '22023';
	end if;
	if jsonb_typeof(coalesce(p_rows, '[]'::jsonb)) <> 'array' then
		raise exception 'p_rows must be a JSON array' using errcode = '22023';
	end if;

	for r in select x from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) x loop
		v_user_id := nullif(btrim(r ->> 'source_user_id'), '');
		v_name := left(nullif(regexp_replace(btrim(coalesce(r ->> 'full_name', r ->> 'legal_name', '')), '\s+', ' ', 'g'), ''), 200);
		if v_user_id is null or v_user_id !~ '^[A-Za-z0-9_-]{6,64}$' or v_name is null
			or public.normalize_person_name(v_name) is null then
			v_rejected := v_rejected + 1;
			continue;
		end if;
		v_email := left(nullif(lower(btrim(r ->> 'email')), ''), 254);
		v_dob := case when (r ->> 'date_of_birth') ~ '^\d{4}-\d{2}-\d{2}$' then (r ->> 'date_of_birth')::date end;

		select coalesce(cp.merged_into_id, cp.id) into v_person
		from public.rams_person_profiles rp join public.canonical_people cp on cp.id = rp.canonical_person_id
		where rp.source_system = 'base44_rams' and rp.source_user_id = v_user_id;
		if v_person is null then
			select * into v_resolved from public.base44_rams_resolve_person(
				p_provider_organization_id, 'person:base44:' || v_user_id, v_name, v_email);
			v_person := v_resolved.person_id;
			if v_resolved.created then v_people_created := v_people_created + 1; end if;
			if v_resolved.needs_review then v_people_review := v_people_review + 1; end if;
		end if;

		update public.canonical_people cp set
			display_name = coalesce(cp.display_name, v_name),
			date_of_birth = coalesce(cp.date_of_birth, v_dob),
			updated_at = clock_timestamp()
		where cp.id = v_person
			and (cp.display_name is null or (cp.date_of_birth is null and v_dob is not null));
		get diagnostics v_rows = row_count;
		v_people_enriched := v_people_enriched + v_rows;

		insert into public.rams_person_profiles as rp (
			organization_id, canonical_person_id, source_user_id, source_url, full_name, legal_name, nickname, email, phone,
			home_address, date_of_birth, firearms_licence_number, firearms_licence_expiry, firearms_licence_status,
			firearms_licence_document_url, account_role, admin_level, is_verified, client_organization_ids,
			source_created_at, source_updated_at, synced_at
		) values (
			p_provider_organization_id, v_person, v_user_id,
			left(coalesce(nullif(btrim(r ->> 'source_url'), ''), 'https://app.base44.com'), 500),
			v_name,
			left(nullif(btrim(r ->> 'legal_name'), ''), 200),
			left(nullif(btrim(r ->> 'nickname'), ''), 120),
			v_email,
			left(nullif(btrim(r ->> 'phone'), ''), 40),
			left(nullif(btrim(r ->> 'home_address'), ''), 500),
			v_dob,
			left(nullif(btrim(r ->> 'firearms_licence_number'), ''), 60),
			case when (r ->> 'firearms_licence_expiry') ~ '^\d{4}-\d{2}-\d{2}$' then (r ->> 'firearms_licence_expiry')::date end,
			left(nullif(lower(btrim(r ->> 'firearms_licence_status')), ''), 40),
			left(nullif(btrim(r ->> 'firearms_licence_document_url'), ''), 1000),
			left(nullif(btrim(r ->> 'account_role'), ''), 60),
			left(nullif(btrim(r ->> 'admin_level'), ''), 60),
			case when jsonb_typeof(r -> 'is_verified') = 'boolean' then (r ->> 'is_verified')::boolean end,
			coalesce((select array_agg(distinct o.id) from jsonb_array_elements_text(
				case when jsonb_typeof(r -> 'client_organization_ids') = 'array' then r -> 'client_organization_ids' else '[]'::jsonb end) c
				join public.organizations o on o.id = case when c ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then c::uuid end), '{}'),
			case when (r ->> 'source_created_at') ~ '^\d{4}-\d{2}-\d{2}T' then (r ->> 'source_created_at')::timestamptz end,
			case when (r ->> 'source_updated_at') ~ '^\d{4}-\d{2}-\d{2}T' then (r ->> 'source_updated_at')::timestamptz end,
			now()
		)
		on conflict (source_system, source_user_id) do update set
			canonical_person_id = excluded.canonical_person_id,
			source_url = excluded.source_url,
			full_name = excluded.full_name,
			legal_name = excluded.legal_name,
			nickname = excluded.nickname,
			email = excluded.email,
			phone = excluded.phone,
			home_address = excluded.home_address,
			date_of_birth = excluded.date_of_birth,
			firearms_licence_number = excluded.firearms_licence_number,
			firearms_licence_expiry = excluded.firearms_licence_expiry,
			firearms_licence_status = excluded.firearms_licence_status,
			firearms_licence_document_url = excluded.firearms_licence_document_url,
			account_role = excluded.account_role,
			admin_level = excluded.admin_level,
			is_verified = excluded.is_verified,
			client_organization_ids = excluded.client_organization_ids,
			source_created_at = excluded.source_created_at,
			source_updated_at = excluded.source_updated_at,
			synced_at = now()
		where rp.organization_id = p_provider_organization_id
		returning id, (xmax = 0) into v_profile, v_inserted;
		if v_profile is null then
			-- The RAMS identity is already held by another provider; never overwrite it.
			v_rejected := v_rejected + 1;
			v_person := null;
			continue;
		end if;
		if v_inserted then v_profiles_created := v_profiles_created + 1; else v_profiles_updated := v_profiles_updated + 1; end if;

		insert into public.canonical_person_links (canonical_person_id, source_table, source_id, organization_id, link_kind, metadata)
		values (v_person, 'rams_person_profiles', v_profile, p_provider_organization_id, 'imported',
			jsonb_build_object('source', 'base44_rams', 'source_user_id', v_user_id))
		on conflict (source_table, source_id) do update set canonical_person_id = excluded.canonical_person_id
		where public.canonical_person_links.canonical_person_id is distinct from excluded.canonical_person_id;

		v_vehicle_ids := '{}';
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
			v_vehicle_ids := v_vehicle_ids || v_vehicle;

			insert into public.rams_person_vehicles as pv (
				organization_id, rams_person_profile_id, canonical_person_id, canonical_vehicle_id, plate_as_recorded,
				make, model, colour, insurance_expiry, company_insurance, company_insurance_comments,
				insurance_document_urls, vehicle_status, archived, synced_at, withdrawn_at
			) values (
				p_provider_organization_id, v_profile, v_person, v_vehicle, left(btrim(v ->> 'plate'), 20),
				left(nullif(btrim(v ->> 'make'), ''), 60), left(nullif(btrim(v ->> 'model'), ''), 60),
				left(nullif(btrim(v ->> 'colour'), ''), 40),
				case when (v ->> 'insurance_expiry') ~ '^\d{4}-\d{2}-\d{2}$' then (v ->> 'insurance_expiry')::date end,
				case when jsonb_typeof(v -> 'company_insurance') = 'boolean' then (v ->> 'company_insurance')::boolean end,
				left(nullif(btrim(v ->> 'company_insurance_comments'), ''), 1000),
				coalesce((select array_agg(left(u, 1000)) from jsonb_array_elements_text(
					case when jsonb_typeof(v -> 'insurance_document_urls') = 'array' then v -> 'insurance_document_urls' else '[]'::jsonb end) u
					where u ~ '^https://'), '{}'),
				left(nullif(lower(btrim(v ->> 'status')), ''), 40),
				case when jsonb_typeof(v -> 'archived') = 'boolean' then (v ->> 'archived')::boolean end,
				now(), null
			)
			on conflict (rams_person_profile_id, canonical_vehicle_id) do update set
				canonical_person_id = excluded.canonical_person_id,
				plate_as_recorded = excluded.plate_as_recorded,
				make = excluded.make,
				model = excluded.model,
				colour = excluded.colour,
				insurance_expiry = excluded.insurance_expiry,
				company_insurance = excluded.company_insurance,
				company_insurance_comments = excluded.company_insurance_comments,
				insurance_document_urls = excluded.insurance_document_urls,
				vehicle_status = excluded.vehicle_status,
				archived = excluded.archived,
				synced_at = now(),
				withdrawn_at = null
			returning (xmax = 0) into v_inserted;
			if v_inserted then v_vehicles_linked := v_vehicles_linked + 1; end if;
		end loop;

		-- The profile carries the person's complete vehicle list, so absent vehicles have left it.
		update public.rams_person_vehicles pv set withdrawn_at = now()
		where pv.rams_person_profile_id = v_profile and pv.withdrawn_at is null
			and not (pv.canonical_vehicle_id = any (v_vehicle_ids));
		get diagnostics v_rows = row_count;
		v_vehicles_withdrawn := v_vehicles_withdrawn + v_rows;

		v_person := null;
		v_profile := null;
	end loop;

	insert into public.audit_log (organization_id, action, target_table, metadata)
	values (p_provider_organization_id, 'sync_base44_rams_people', 'rams_person_profiles', jsonb_build_object(
		'source', 'base44_rams', 'received', jsonb_array_length(coalesce(p_rows, '[]'::jsonb)),
		'profiles_created', v_profiles_created, 'profiles_updated', v_profiles_updated, 'rejected', v_rejected,
		'people_created', v_people_created, 'people_needing_review', v_people_review, 'people_enriched', v_people_enriched,
		'vehicles_linked', v_vehicles_linked, 'vehicles_withdrawn', v_vehicles_withdrawn));

	return jsonb_build_object('profiles_created', v_profiles_created, 'profiles_updated', v_profiles_updated,
		'rejected', v_rejected, 'people_created', v_people_created, 'people_needing_review', v_people_review,
		'people_enriched', v_people_enriched, 'vehicles_linked', v_vehicles_linked, 'vehicles_withdrawn', v_vehicles_withdrawn);
end;
$function$;

comment on function public.ingest_base44_rams_people(uuid, jsonb) is 'Server-only upsert of RAMS user profiles read from Base44: resolves or creates the canonical person (never by name alone), fills blank canonical name/date of birth, mirrors every supplied detail into rams_person_profiles with a canonical_person_links entry, and links the person''s registered vehicles through canonical_vehicles into rams_person_vehicles. Writes one audit_log entry per call.';
revoke all on function public.ingest_base44_rams_people(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.ingest_base44_rams_people(uuid, jsonb) to service_role;

create or replace function public.ingest_base44_rams_companions(
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
	v_holder_user text;
	v_holder uuid;
	v_companion uuid;
	v_name text;
	v_email text;
	v_resolved record;
	v_inserted boolean;
	v_created integer := 0;
	v_updated integer := 0;
	v_people_created integer := 0;
	v_people_review integer := 0;
	v_rejected integer := 0;
begin
	if p_provider_organization_id is null
		or not exists (select 1 from public.organizations o where o.id = p_provider_organization_id) then
		raise exception 'unknown provider organization' using errcode = '22023';
	end if;
	if jsonb_typeof(coalesce(p_rows, '[]'::jsonb)) <> 'array' then
		raise exception 'p_rows must be a JSON array' using errcode = '22023';
	end if;

	for r in select x from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) x loop
		v_holder_user := nullif(btrim(r ->> 'holder_user_id'), '');
		v_name := left(nullif(regexp_replace(btrim(coalesce(r ->> 'full_name', '')), '\s+', ' ', 'g'), ''), 200);
		v_email := left(nullif(lower(btrim(r ->> 'email')), ''), 254);
		v_holder := null;
		v_companion := null;
		if v_holder_user is not null and v_holder_user ~ '^[A-Za-z0-9_-]{6,64}$' then
			select coalesce(cp.merged_into_id, cp.id) into v_holder
			from public.rams_person_profiles rp join public.canonical_people cp on cp.id = rp.canonical_person_id
			where rp.source_system = 'base44_rams' and rp.source_user_id = v_holder_user
				and rp.organization_id = p_provider_organization_id;
			if v_holder is null then
				select coalesce(cp.merged_into_id, cp.id) into v_holder
				from public.canonical_people cp where cp.canonical_key = 'person:base44:' || v_holder_user;
			end if;
		end if;
		if v_holder is null or v_name is null or public.normalize_person_name(v_name) is null then
			v_rejected := v_rejected + 1;
			continue;
		end if;

		-- A companion who is a RAMS user in their own right resolves to that person.
		if v_email is not null then
			select coalesce(cp.merged_into_id, cp.id) into v_companion
			from public.rams_person_profiles rp join public.canonical_people cp on cp.id = rp.canonical_person_id
			where rp.organization_id = p_provider_organization_id and rp.email = v_email
			order by rp.synced_at desc limit 1;
		end if;
		if v_companion is null then
			select * into v_resolved from public.base44_rams_resolve_person(
				p_provider_organization_id,
				'person:base44-companion:' || coalesce(v_email, v_holder_user || ':' || public.normalize_person_name(v_name)),
				v_name, v_email);
			v_companion := v_resolved.person_id;
			if v_resolved.created then v_people_created := v_people_created + 1; end if;
			if v_resolved.needs_review then v_people_review := v_people_review + 1; end if;
		end if;
		if v_companion = v_holder then
			v_rejected := v_rejected + 1;
			continue;
		end if;

		insert into public.rams_person_associations as a (
			organization_id, client_organization_id, canonical_person_id, associated_canonical_person_id, holder_source_user_id,
			companion_name, companion_email, companion_phone, permitted_status, booking_count, first_booking_date,
			last_booking_date, last_hunting_area, synced_at
		) values (
			p_provider_organization_id,
			(select o.id from public.organizations o where o.id = case
				when (r ->> 'client_organization_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
				then (r ->> 'client_organization_id')::uuid end),
			v_holder, v_companion, v_holder_user, v_name, v_email,
			left(nullif(btrim(r ->> 'phone'), ''), 40),
			left(nullif(lower(btrim(r ->> 'permitted_status')), ''), 40),
			least(greatest(coalesce(case when (r ->> 'booking_count') ~ '^\d{1,6}$' then (r ->> 'booking_count')::integer end, 0), 0), 100000),
			case when (r ->> 'first_booking_date') ~ '^\d{4}-\d{2}-\d{2}$' then (r ->> 'first_booking_date')::date end,
			case when (r ->> 'last_booking_date') ~ '^\d{4}-\d{2}-\d{2}$' then (r ->> 'last_booking_date')::date end,
			left(nullif(btrim(r ->> 'last_hunting_area'), ''), 200),
			now()
		)
		on conflict (organization_id, canonical_person_id, associated_canonical_person_id, relationship) do update set
			client_organization_id = coalesce(excluded.client_organization_id, a.client_organization_id),
			holder_source_user_id = excluded.holder_source_user_id,
			companion_name = excluded.companion_name,
			companion_email = coalesce(excluded.companion_email, a.companion_email),
			companion_phone = coalesce(excluded.companion_phone, a.companion_phone),
			permitted_status = coalesce(excluded.permitted_status, a.permitted_status),
			booking_count = excluded.booking_count,
			first_booking_date = excluded.first_booking_date,
			last_booking_date = excluded.last_booking_date,
			last_hunting_area = excluded.last_hunting_area,
			synced_at = now()
		returning (xmax = 0) into v_inserted;
		if v_inserted then v_created := v_created + 1; else v_updated := v_updated + 1; end if;
	end loop;

	insert into public.audit_log (organization_id, action, target_table, metadata)
	values (p_provider_organization_id, 'sync_base44_rams_companions', 'rams_person_associations', jsonb_build_object(
		'source', 'base44_rams', 'received', jsonb_array_length(coalesce(p_rows, '[]'::jsonb)),
		'created', v_created, 'updated', v_updated, 'rejected', v_rejected,
		'people_created', v_people_created, 'people_needing_review', v_people_review));

	return jsonb_build_object('created', v_created, 'updated', v_updated, 'rejected', v_rejected,
		'people_created', v_people_created, 'people_needing_review', v_people_review);
end;
$function$;

comment on function public.ingest_base44_rams_companions(uuid, jsonb) is 'Server-only upsert of RAMS booking companions (one row per permit holder and companion, aggregated across bookings) into rams_person_associations, resolving both sides to canonical people. Writes one audit_log entry per call.';
revoke all on function public.ingest_base44_rams_companions(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.ingest_base44_rams_companions(uuid, jsonb) to service_role;

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
	v_user_id text;
	v_person uuid;
	v_resolved record;
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
			select coalesce(cp.merged_into_id, cp.id) into v_person
			from public.rams_person_profiles rp join public.canonical_people cp on cp.id = rp.canonical_person_id
			where rp.source_system = 'base44_rams' and rp.source_user_id = v_user_id
				and rp.organization_id = p_provider_organization_id;
			if v_person is null then
				select * into v_resolved from public.base44_rams_resolve_person(
					p_provider_organization_id, 'person:base44:' || v_user_id, v_holder, r ->> 'contact_email');
				v_person := v_resolved.person_id;
				if v_resolved.created then v_people_created := v_people_created + 1; end if;
				if v_resolved.needs_review then v_people_review := v_people_review + 1; end if;
			end if;

			insert into public.person_permits (
				organization_id, client_organization_id, canonical_person_id, permit_number, permit_type, applicant_type,
				company_name, activities, date_to, firearm_confirm, firearm_licence_valid, firearm_licence_number, conditions,
				status, contact_email, contact_phone, address_text, compliance_checked_at, compliance_source, source_document
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
				left(nullif(btrim(r ->> 'firearm_licence_number'), ''), 60),
				left(nullif(btrim(r ->> 'conditions'), ''), 4000),
				v_status, left(nullif(lower(btrim(r ->> 'contact_email')), ''), 254), left(nullif(btrim(r ->> 'contact_phone'), ''), 40),
				left(nullif(btrim(r ->> 'address'), ''), 500),
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
				firearm_licence_number = coalesce(left(nullif(btrim(r ->> 'firearm_licence_number'), ''), 60), pp.firearm_licence_number),
				conditions = coalesce(left(nullif(btrim(r ->> 'conditions'), ''), 4000), pp.conditions),
				address_text = coalesce(left(nullif(btrim(r ->> 'address'), ''), 500), pp.address_text),
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

comment on function public.ingest_base44_rams_permits(uuid, jsonb) is 'Server-only upsert of RAMS permits read from Base44 into person_permits (idempotent on organization_id, permit_number), with the holder resolved through their RAMS profile, else by email and normalised name within the provider (otherwise a draft keyed by the Base44 user id, flagged for review on a same-name clash) and permit vehicles linked through canonical_vehicles. Existing permits keep their linked person. Writes one audit_log entry per call.';
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
