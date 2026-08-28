create table "public"."tenders" (
  "id"                     uuid                     not null default gen_random_uuid(),
  "organization_id"        uuid                     not null,
  "client_organization_id" uuid,
  "title"                  text                     not null,
  "service_type"           text,
  "estimated_value"        numeric(12,2),
  "currency"               text                     not null default 'NZD'::text,
  "due_date"               date,
  "status"                 text                     not null default 'draft'::text,
  "lead_author_id"         uuid,
  "notes"                  text,
  "created_by"             uuid,
  "created_at"             timestamp with time zone not null default now(),
  "updated_at"             timestamp with time zone not null default now(),
  constraint "tenders_client_organization_id_fkey" foreign key (client_organization_id) references public.organizations(id),
  constraint "tenders_organization_id_fkey" foreign key (organization_id) references public.organizations(id),
  constraint "tenders_pkey" primary key (id),
  constraint "tenders_status_check" check ((status = ANY (ARRAY['draft'::text, 'in_review'::text, 'submitted'::text, 'awarded'::text, 'declined'::text]))),
  constraint "tenders_created_by_fkey" foreign key (created_by) references public.user_profiles(id),
  constraint "tenders_lead_author_id_fkey" foreign key (lead_author_id) references public.user_profiles(id)
);

alter table "public"."tenders"
  enable row level security;

create index idx_tenders_due_date on public.tenders using btree (due_date);

create index idx_tenders_org on public.tenders using btree (organization_id);

create index idx_tenders_status on public.tenders using btree (status);

create policy "bob_full_read" on "public"."tenders"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "tenders_insert" on "public"."tenders"
  for insert
  to PUBLIC
  with check ((public.is_admin_for_org(organization_id) AND (EXISTS ( SELECT 1
   FROM public.user_profiles up
  WHERE ((up.id = auth.uid()) AND (up.role = ANY (ARRAY['grand_master'::text, 'master'::text])))))));

create policy "tenders_select" on "public"."tenders"
  for select
  to PUBLIC
  using ((public.org_access_allowed(organization_id) AND (exists ( select 1
   from public.user_profiles up
  where ((up.id = auth.uid()) AND (up.role = ANY (ARRAY['grand_master'::text, 'master'::text])))))));

create policy "tenders_update" on "public"."tenders"
  for update
  to PUBLIC
  using ((public.is_admin_for_org(organization_id) AND (exists ( select 1
   from public.user_profiles up
  where ((up.id = auth.uid()) AND (up.role = ANY (ARRAY['grand_master'::text, 'master'::text])))))))
  with check ((public.is_admin_for_org(organization_id) AND (EXISTS ( SELECT 1
   FROM public.user_profiles up
  WHERE ((up.id = auth.uid()) AND (up.role = ANY (ARRAY['grand_master'::text, 'master'::text])))))));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."tenders" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."tenders" is 'Tender/proposal workspace. Master role only per instruction manual.';
