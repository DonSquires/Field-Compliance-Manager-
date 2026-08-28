create table "public"."ptt_transmissions" (
  "id"              uuid                     not null default gen_random_uuid(),
  "organization_id" uuid                     not null,
  "channel_id"      uuid,
  "speaker_user_id" uuid,
  "state"           text                     not null,
  "started_at"      timestamp with time zone not null default now(),
  "ended_at"        timestamp with time zone,
  "emergency"       boolean                  not null default false,
  "metadata"        jsonb                    not null default '{}'::jsonb,
  constraint "ptt_transmissions_channel_id_fkey" foreign key (channel_id) references public.ptt_channels(id),
  constraint "ptt_transmissions_organization_id_fkey" foreign key (organization_id) references public.organizations(id),
  constraint "ptt_transmissions_pkey" primary key (id),
  constraint "ptt_transmissions_state_check" check ((state = ANY (ARRAY['started'::text, 'ended'::text, 'failed'::text, 'emergency'::text]))),
  constraint "ptt_transmissions_speaker_user_id_fkey" foreign key (speaker_user_id) references public.user_profiles(id)
);

alter table "public"."ptt_transmissions"
  enable row level security;

create policy "bob_full_read" on "public"."ptt_transmissions"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "ptt_transmissions_insert" on "public"."ptt_transmissions"
  for insert
  to PUBLIC
  with check (public.org_access_allowed(organization_id));

create policy "ptt_transmissions_select" on "public"."ptt_transmissions"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

create policy "ptt_transmissions_update" on "public"."ptt_transmissions"
  for update
  to PUBLIC
  using (public.org_access_allowed(organization_id))
  with check (public.org_access_allowed(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."ptt_transmissions" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."ptt_transmissions" is 'PTT transmission audit trail. Emergency flag triggers supervisor alerts.';
