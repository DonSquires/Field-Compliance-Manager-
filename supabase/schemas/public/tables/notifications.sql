create table "public"."notifications" (
  "id"                uuid                     not null default gen_random_uuid(),
  "organization_id"   uuid                     not null,
  "recipient_user_id" uuid,
  "recipient_role"    text,
  "category"          text                     not null,
  "severity"          text                     not null default 'info'::text,
  "title"             text                     not null,
  "body"              text,
  "link_page"         text,
  "link_payload"      jsonb,
  "dedup_key"         text,
  "read_at"           timestamp with time zone,
  "created_at"        timestamp with time zone not null default now(),
  constraint "notifications_category_check"
    check
    ((category = ANY (ARRAY['credential_expiry'::text, 'sla_breach'::text, 'report_ready'::text, 'welfare'::text, 'dispatch'::text, 'system'::text, 'schema_change_request'::text,
    'bob_conversation'::text, 'bob_self_memory'::text]))),
  constraint "notifications_pkey" primary key (id),
  constraint "notifications_recipient_chk" check (((recipient_user_id IS NOT NULL) OR (recipient_role IS NOT NULL))),
  constraint "notifications_severity_check" check ((severity = ANY (ARRAY['info'::text, 'warning'::text, 'critical'::text]))),
  constraint "notifications_organization_id_fkey" foreign key (organization_id) references public.organizations(id) on delete cascade,
  constraint "notifications_recipient_user_id_fkey" foreign key (recipient_user_id) references public.user_profiles(id) on delete cascade
);

alter table "public"."notifications"
  enable row level security;

create index idx_notifications_org on public.notifications using btree (organization_id);

create index idx_notifications_recipient on public.notifications using btree (recipient_user_id)
  where (recipient_user_id is not null);

create index idx_notifications_role on public.notifications using btree (recipient_role)
  where (recipient_role is not null);

create index idx_notifications_unread on public.notifications using btree (organization_id, created_at desc)
  where (read_at is null);

create unique index uq_notifications_dedup on public.notifications using btree (organization_id, dedup_key)
  where (dedup_key is not null);

create policy "bob_full_read" on "public"."notifications"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "notifications_insert" on "public"."notifications"
  for insert
  to PUBLIC
  with check (public.is_admin_for_org(organization_id));

create policy "notifications_select" on "public"."notifications"
  for select
  to PUBLIC
  using ((public.org_access_allowed(organization_id) AND ((recipient_user_id = auth.uid()) or ((recipient_user_id is null) AND (recipient_role = public.current_user_role())))));

create policy "notifications_update" on "public"."notifications"
  for update
  to PUBLIC
  using ((public.org_access_allowed(organization_id) AND ((recipient_user_id = auth.uid()) or ((recipient_user_id is null) AND (recipient_role = public.current_user_role())))))
  with
    check ((public.org_access_allowed(organization_id) AND ((recipient_user_id = auth.uid()) OR ((recipient_user_id IS NULL) AND (recipient_role = public.current_user_role())))));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."notifications" to "anon", "authenticated", "postgres", "service_role";

comment on column "public"."notifications"."category" is 'Notification class. bob_conversation = Bob proactive reach-out that opens BobPanel on a specific conversation (link_payload.conversation_id).';

comment on table "public"."notifications" is 'Layer 4.4 notification centre. Org-scoped; personal (recipient_user_id) or role-broadcast (recipient_role). Producers write via enqueue_notification().';
