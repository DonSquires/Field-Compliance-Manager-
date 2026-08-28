create table "public"."bob_owner_rulings" (
  "id"            uuid                     not null default gen_random_uuid(),
  "ruling_key"    text                     not null,
  "title"         text                     not null,
  "ruling_text"   text                     not null,
  "domain"        text                     not null default 'general'::text,
  "ruling_status" text                     not null default 'active'::text,
  "superseded_by" uuid,
  "authored_by"   text                     not null default 'owner'::text,
  "source"        text,
  "created_at"    timestamp with time zone not null default now(),
  "updated_at"    timestamp with time zone not null default now(),
  constraint "bob_owner_rulings_domain_check"
    check ((domain = ANY (ARRAY['general'::text, 'entity_resolution'::text, 'spatial'::text, 'governance'::text, 'billing'::text, 'module'::text, 'crm'::text]))),
  constraint "bob_owner_rulings_pkey" primary key (id),
  constraint "bob_owner_rulings_ruling_status_check" check ((ruling_status = ANY (ARRAY['active'::text, 'superseded'::text]))),
  constraint "bob_owner_rulings_superseded_by_fkey" foreign key (superseded_by) references public.bob_owner_rulings(id)
);

alter table "public"."bob_owner_rulings"
  enable row level security;

create index idx_bob_owner_rulings_domain on public.bob_owner_rulings using btree (domain)
  where (ruling_status = 'active'::text);

create index idx_bob_owner_rulings_status on public.bob_owner_rulings using btree (ruling_status);

create unique index uniq_bob_owner_ruling_key on public.bob_owner_rulings using btree (ruling_key)
  where (ruling_status = 'active'::text);

create policy "bob_full_read" on "public"."bob_owner_rulings"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "bob_owner_rulings_select" on "public"."bob_owner_rulings"
  for select
  to PUBLIC
  using (true);

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."bob_owner_rulings" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."bob_owner_rulings" is 'Owner decisions that override general knowledge. The "one sentence a human already knows" that prevents verified-but-wrong answers. Owner-authored only; never machine-generated. Bob queries these via bob_recall_prior_context (0301) at HIGHER AUTHORITY than knowledge cards. Issue #232, epic #228.';
