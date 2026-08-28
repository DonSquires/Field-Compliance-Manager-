create table "public"."officer_command_requests" (
  "id"              uuid                     not null default gen_random_uuid(),
  "request_id"      text                     not null,
  "organization_id" uuid                     not null,
  "actor_user_id"   uuid,
  "shift_id"        uuid,
  "site_id"         uuid,
  "command_type"    text                     not null,
  "command_status"  text                     not null,
  "response"        jsonb                    not null default '{}'::jsonb,
  "created_at"      timestamp with time zone not null default now(),
  constraint "officer_command_requests_pkey" primary key (id),
  constraint "officer_command_requests_request_id_key" unique (request_id),
  constraint "officer_command_requests_organization_id_fkey" foreign key (organization_id) references public.organizations(id) on delete cascade,
  constraint "officer_command_requests_actor_user_id_fkey" foreign key (actor_user_id) references public.user_profiles(id)
);

alter table "public"."officer_command_requests"
  enable row level security;

create index idx_ocr_org on public.officer_command_requests using btree (organization_id);

create policy "bob_full_read" on "public"."officer_command_requests"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "ocr_org_select" on "public"."officer_command_requests"
  for select
  to "authenticated"
  using (public.org_access_allowed(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."officer_command_requests" to "anon", "authenticated", "postgres", "service_role";
