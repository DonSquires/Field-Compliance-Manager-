create table "public"."quote_lines" (
  "id"                 uuid                     not null default gen_random_uuid(),
  "quote_id"           uuid                     not null,
  "kind"               text                     not null default 'custom'::text,
  "description"        text                     not null,
  "quantity"           numeric(12,2)            not null default 1,
  "unit_cost"          numeric(12,2)            not null default 0,
  "unit_charge"        numeric(12,2)            not null default 0,
  "module_key"         text,
  "site_id"            uuid,
  "line_order"         integer                  not null default 0,
  "created_at"         timestamp with time zone not null default now(),
  "source_dispatch_id" uuid,
  constraint "quote_lines_kind_check" check ((kind = ANY (ARRAY['labour'::text, 'travel'::text, 'overhead'::text, 'platform_fee'::text, 'module'::text, 'custom'::text]))),
  constraint "quote_lines_pkey" primary key (id),
  constraint "quote_lines_quote_id_fkey" foreign key (quote_id) references public.quotes(id) on delete cascade
);

alter table "public"."quote_lines"
  enable row level security;

create index idx_quote_lines_quote on public.quote_lines using btree (quote_id);

create unique index idx_quote_lines_source_dispatch on public.quote_lines using btree (quote_id, source_dispatch_id)
  where (source_dispatch_id is not null);

create policy "bob_full_read" on "public"."quote_lines"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "gm_full_access" on "public"."quote_lines"
  for all
  to "authenticated"
  using (public.is_grand_master())
  with check (public.is_grand_master());

create policy "quote_lines_select" on "public"."quote_lines"
  for select
  to PUBLIC
  using ((exists ( select 1
   from public.quotes q
  where ((q.id = quote_lines.quote_id) AND (public.is_grand_master() or (q.provider_org_id in ( select up.organization_id
           from public.user_profiles up
          where (up.id = auth.uid()))))))));

create policy "quote_lines_write" on "public"."quote_lines"
  for all
  to PUBLIC
  using ((exists ( select 1
   from public.quotes q
  where ((q.id = quote_lines.quote_id) AND (public.is_grand_master() or ((q.provider_org_id in ( select up.organization_id
           from public.user_profiles up
          where (up.id = auth.uid()))) AND (( select user_profiles.role
           from public.user_profiles
          where (user_profiles.id = auth.uid())) = ANY (ARRAY['grand_master'::text, 'master'::text, 'admin'::text, 'admin_officer'::text]))))))))
  with check ((EXISTS ( SELECT 1
   FROM public.quotes q
  WHERE ((q.id = quote_lines.quote_id) AND (public.is_grand_master() OR ((q.provider_org_id IN ( SELECT up.organization_id
           FROM public.user_profiles up
          WHERE (up.id = auth.uid()))) AND (( SELECT user_profiles.role
           FROM public.user_profiles
          WHERE (user_profiles.id = auth.uid())) = ANY (ARRAY['grand_master'::text, 'master'::text, 'admin'::text, 'admin_officer'::text]))))))));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."quote_lines" to "anon", "authenticated", "postgres", "service_role";

comment on column "public"."quote_lines"."source_dispatch_id" is 'FK to dispatch_jobs.id for on-charge lines auto-created by the completion pipeline. Partial unique index prevents duplicate on-charge lines per job per quote.';

comment on table "public"."quote_lines" is 'One line of a quote. unit_cost (provider pay) + unit_charge (client price) = cost-vs-charge. kind platform_fee lines are generated from the provider Layer-1 effective price (org_module_subscriptions override-else-module_catalog) so client pricing recovers the platform cost.';
