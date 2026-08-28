create table "public"."bob_signing_audit" (
  "id"            uuid                     not null default gen_random_uuid(),
  "identity_id"   uuid                     not null,
  "event_type"    text                     not null,
  "event_payload" jsonb                    not null default '{}'::jsonb,
  "created_at"    timestamp with time zone not null default now(),
  "actor_user_id" uuid,
  constraint "bob_signing_audit_actor_user_id_fkey" foreign key (actor_user_id) references auth.users(id),
  constraint "bob_signing_audit_event_type_check" check ((event_type = ANY (ARRAY['sign_request'::text, 'sign_success'::text, 'sign_failure'::text, 'identity_check'::text]))),
  constraint "bob_signing_audit_pkey" primary key (id),
  constraint "bob_signing_audit_identity_id_fkey" foreign key (identity_id) references public.bob_signing_identities(id) on delete cascade
);

alter table "public"."bob_signing_audit"
  enable row level security;

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."bob_signing_audit" to "postgres", "service_role";
