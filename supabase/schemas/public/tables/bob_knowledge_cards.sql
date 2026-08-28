create table "public"."bob_knowledge_cards" (
  "id"              uuid                     not null default gen_random_uuid(),
  "organization_id" uuid,
  "category"        text                     not null,
  "key"             text                     not null,
  "title"           text                     not null,
  "content"         text                     not null,
  "tags"            text[]                   not null default '{}'::text[],
  "source"          text,
  "is_active"       boolean                  not null default true,
  "created_at"      timestamp with time zone not null default now(),
  "updated_at"      timestamp with time zone not null default now(),
  "embedding"       public.vector(768),
  "embedding_model" text,
  "embedded_at"     timestamp with time zone,
  "embedding_384"   public.vector(384),
  constraint "bob_knowledge_cards_pkey" primary key (id),
  constraint "bob_knowledge_cards_organization_id_fkey" foreign key (organization_id) references public.organizations(id) on delete cascade
);

alter table "public"."bob_knowledge_cards"
  enable row level security;

create index idx_bob_knowledge_cards_category on public.bob_knowledge_cards using btree (category)
  where is_active;

create unique index uniq_bob_knowledge_card_key on public.bob_knowledge_cards using btree (COALESCE(organization_id, '00000000-0000-0000-0000-000000000000'::uuid), key)
  where is_active;

create policy "bob_full_read" on "public"."bob_knowledge_cards"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "bob_knowledge_cards_select" on "public"."bob_knowledge_cards"
  for select
  to PUBLIC
  using (((organization_id is null) or public.org_access_allowed(organization_id)));

create policy "bob_knowledge_cards_write" on "public"."bob_knowledge_cards"
  for all
  to PUBLIC
  using (((organization_id is not null) AND public.is_admin_for_org(organization_id)))
  with check (((organization_id IS NOT NULL) AND public.is_admin_for_org(organization_id)));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."bob_knowledge_cards" to "anon", "authenticated", "postgres", "service_role";

comment on column "public"."bob_knowledge_cards"."embedding" is 'nomic-embed-text 768-dim card embedding. Searched EXACTLY (sequential scan) by bob_match_knowledge -- there is deliberately NO vector index. 0116 created an IVFFlat index with lists=100; at ~250 cards that is ~2-3 vectors per partition, and the default ivfflat.probes=1 meant retrieval scanned one partition and returned 2-3 rows regardless of match_count. See 0381.';

comment on table "public"."bob_knowledge_cards" is 'Authoritative retrievable knowledge for Bob grounding: product purpose, modules/features, and legal/governance/privacy obligations. organization_id null = platform canonical.';
