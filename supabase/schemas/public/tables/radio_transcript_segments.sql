create table "public"."radio_transcript_segments" (
  "id"              uuid                     not null default gen_random_uuid(),
  "organization_id" uuid                     not null,
  "transmission_id" uuid                     not null,
  "sequence"        integer                  not null,
  "text"            text                     not null,
  "confidence"      real,
  "is_final"        boolean                  not null default false,
  "created_at"      timestamp with time zone not null default now(),
  constraint "radio_transcript_segments_organization_id_fkey" foreign key (organization_id) references public.organizations(id),
  constraint "radio_transcript_segments_pkey" primary key (id),
  constraint "radio_transcript_segments_transmission_id_fkey" foreign key (transmission_id) references public.ptt_transmissions(id) on delete cascade
);

alter table "public"."radio_transcript_segments"
  enable row level security;

create policy "bob_full_read" on "public"."radio_transcript_segments"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "radio_transcript_segments_select" on "public"."radio_transcript_segments"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."radio_transcript_segments" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."radio_transcript_segments" is 'STT transcript segments per PTT transmission. Confidence and final flag tracked.';
