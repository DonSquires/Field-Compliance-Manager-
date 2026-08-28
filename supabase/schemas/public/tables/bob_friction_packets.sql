create table "public"."bob_friction_packets" (
  "id"                uuid                     not null default gen_random_uuid(),
  "organization_id"   uuid                     not null,
  "user_id"           uuid                     not null,
  "client_packet_key" text                     not null,
  "envelope"          jsonb                    not null default '{}'::jsonb,
  "triage"            text,
  "basis"             jsonb                    not null default '{}'::jsonb,
  "confidence"        numeric(4,3),
  "route"             text,
  "stop_line_hit"     text,
  "truth_state"       text                     not null default 'inferred'::text,
  "redaction"         jsonb                    not null default '{}'::jsonb,
  "disposition"       text                     not null default 'open'::text,
  "retention_cutoff"  timestamp with time zone,
  "created_at"        timestamp with time zone not null default now(),
  constraint "bob_friction_packets_confidence_check" check (((confidence IS NULL) OR ((confidence >= (0)::numeric) AND (confidence <= (1)::numeric)))),
  constraint "bob_friction_packets_disposition_check" check ((disposition = ANY (ARRAY['open'::text, 'reviewing'::text, 'resolved'::text, 'dismissed'::text]))),
  constraint "bob_friction_packets_pkey" primary key (id),
  constraint "bob_friction_packets_route_check"
    check ((route = ANY (ARRAY['self_heal_apparatus'::text, 'dispatch_flow'::text, 'grand_master_bell'::text, 'answer_user'::text, 'none'::text]))),
  constraint "bob_friction_packets_triage_check" check ((triage = ANY (ARRAY['bug'::text, 'ux_gap'::text, 'data_problem'::text, 'misunderstanding'::text, 'unknown'::text]))),
  constraint "bob_friction_packets_truth_state_check" check ((truth_state = 'inferred'::text)),
  constraint "bob_friction_packets_organization_id_fkey" foreign key (organization_id) references public.organizations(id) on delete cascade,
  constraint "bob_friction_packets_user_id_fkey" foreign key (user_id) references public.user_profiles(id) on delete cascade
);

alter table "public"."bob_friction_packets"
  enable row level security;

create index idx_bob_friction_packets_created on public.bob_friction_packets using btree (created_at);

create index idx_bob_friction_packets_disposition on public.bob_friction_packets using btree (disposition)
  where (disposition <> 'resolved'::text);

create unique index idx_bob_friction_packets_idempotency on public.bob_friction_packets using btree (organization_id, client_packet_key);

create index idx_bob_friction_packets_org on public.bob_friction_packets using btree (organization_id);

create index idx_bob_friction_packets_route on public.bob_friction_packets using btree (route)
  where (route is not null);

create index idx_bob_friction_packets_user on public.bob_friction_packets using btree (user_id);

create trigger trg_bob_friction_packets_immutable_envelope
  before update on public.bob_friction_packets
  for each row
  execute function public.bob_friction_packets_immutable_envelope();

create policy "bob_friction_packets_insert" on "public"."bob_friction_packets"
  for insert
  to PUBLIC
  with check (public.org_access_allowed(organization_id));

create policy "bob_friction_packets_select" on "public"."bob_friction_packets"
  for select
  to PUBLIC
  using ((public.org_access_allowed(organization_id) AND ((user_id = auth.uid()) or public.is_grand_master() or public.is_admin_for_org(organization_id))));

create policy "bob_friction_packets_update" on "public"."bob_friction_packets"
  for update
  to PUBLIC
  using ((public.org_access_allowed(organization_id) AND ((user_id = auth.uid()) or public.is_grand_master() or public.is_admin_for_org(organization_id))));

create policy "bob_full_read" on "public"."bob_friction_packets"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."bob_friction_packets" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."bob_friction_packets" is 'Friction-triage audit table. Each row is an immutable evidence envelope (what Bob perceived) plus the triage verdict and routing decision. Design: docs/bob/BOB_FRICTION_TRIAGE_DESIGN.md, plan: docs/proposals/BOB_TRIAGE_REPORT_PLAN.md.';
