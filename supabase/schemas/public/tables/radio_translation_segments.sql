create table "public"."radio_translation_segments" (
  "id"              uuid                     not null default gen_random_uuid(),
  "organization_id" uuid                     not null,
  "transcript_id"   uuid                     not null,
  "target_language" text                     not null,
  "translated_text" text                     not null,
  "provider"        text,
  "confidence"      real,
  "created_at"      timestamp with time zone not null default now(),
  constraint "radio_translation_segments_organization_id_fkey" foreign key (organization_id) references public.organizations(id),
  constraint "radio_translation_segments_pkey" primary key (id),
  constraint "radio_translation_segments_transcript_id_fkey" foreign key (transcript_id) references public.radio_transcript_segments(id) on delete cascade
);

alter table "public"."radio_translation_segments"
  enable row level security;

create policy "bob_full_read" on "public"."radio_translation_segments"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "radio_translation_segments_select" on "public"."radio_translation_segments"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."radio_translation_segments" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."radio_translation_segments" is 'Per-segment translated caption output for PTT universal translator.';
