create table "public"."effective_rule_snapshots" (
  "id"                          uuid                     not null default gen_random_uuid(),
  "organization_id"             uuid                     not null,
  "module_key"                  text                     not null,
  "governing_jurisdiction_id"  uuid,
  "governing_jurisdiction_name" text,
  "matched_zone_id"             uuid,
  "matched_site_id"             uuid,
  "matched_location_id"         uuid,
  "rule_set_id"                 uuid,
  "rule_set_name"               text,
  "jurisdiction_rule_set_id"    uuid,
  "effective_rules"             jsonb                    not null default '{}'::jsonb,
  "resolution_status"           text                     not null default 'outside_all_geofences',
  "source_event_table"          text,
  "source_event_id"             uuid,
  "captured_at"                 timestamp with time zone not null default now(),
  "created_at"                  timestamp with time zone not null default now(),
  constraint "effective_rule_snapshots_pkey" primary key (id),
  constraint "effective_rule_snapshots_source_unique" unique (source_event_table, source_event_id),
  constraint "effective_rule_snapshots_organization_id_fkey" foreign key (organization_id) references public.organizations(id) on delete cascade,
  constraint "effective_rule_snapshots_governing_jurisdiction_id_fkey" foreign key (governing_jurisdiction_id) references public.organizations(id) on delete restrict,
  constraint "effective_rule_snapshots_matched_zone_id_fkey" foreign key (matched_zone_id) references public.location_zones(id) on delete restrict,
  constraint "effective_rule_snapshots_matched_site_id_fkey" foreign key (matched_site_id) references public.client_sites(id) on delete restrict,
  constraint "effective_rule_snapshots_matched_location_id_fkey" foreign key (matched_location_id) references public.locations(id) on delete restrict,
  constraint "effective_rule_snapshots_jurisdiction_rule_set_id_fkey" foreign key (jurisdiction_rule_set_id) references public.jurisdiction_rule_sets(id) on delete restrict
);

create index idx_effective_rule_snapshots_event on public.effective_rule_snapshots using btree (source_event_table, source_event_id);
create index idx_effective_rule_snapshots_module on public.effective_rule_snapshots using btree (module_key, governing_jurisdiction_id, captured_at desc);

grant select on public.effective_rule_snapshots to authenticated, service_role;
