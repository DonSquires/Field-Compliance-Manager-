create table "public"."notice_print_authorizations" (
  "id" uuid not null default gen_random_uuid(),
  "organization_id" uuid not null,
  "breach_alert_id" uuid not null,
  "notice_type" text not null,
  "request_id" uuid not null,
  "authorized_by" uuid not null,
  "authorized_name" text not null,
  "status" text not null default 'authorized'::text,
  "response" jsonb,
  "error_message" text,
  "created_at" timestamp with time zone not null default now(),
  "completed_at" timestamp with time zone,
  constraint "notice_print_authorizations_pkey" primary key (id),
  constraint "notice_print_authorizations_request_id_key" unique (request_id),
  constraint "notice_print_authorizations_notice_type_check"
    check (notice_type in ('written_warning', 'notice_to_vacate', 'infringement')),
  constraint "notice_print_authorizations_status_check"
    check (status in ('authorized', 'completed', 'failed')),
  constraint "notice_print_authorizations_organization_id_fkey"
    foreign key (organization_id) references public.organizations(id),
  constraint "notice_print_authorizations_breach_alert_id_fkey"
    foreign key (breach_alert_id) references public.breach_alerts(id),
  constraint "notice_print_authorizations_authorized_by_fkey"
    foreign key (authorized_by) references public.user_profiles(id)
);

alter table "public"."notice_print_authorizations" enable row level security;

create index idx_notice_print_authorizations_alert
  on public.notice_print_authorizations using btree (breach_alert_id, created_at desc);

revoke all on table "public"."notice_print_authorizations" from public, "anon", "authenticated";
grant select, insert, update on table "public"."notice_print_authorizations" to "service_role";

comment on table "public"."notice_print_authorizations"
  is 'Server-only idempotency and receipt ledger for typed-name notice print authorization. Browser roles have no direct table access.';
