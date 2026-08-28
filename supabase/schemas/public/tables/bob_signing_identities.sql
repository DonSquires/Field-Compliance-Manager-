create table "public"."bob_signing_identities" (
  "id"                 uuid                     not null default gen_random_uuid(),
  "provider"           text                     not null,
  "key_name"           text                     not null,
  "fingerprint_sha256" text                     not null,
  "enabled"            boolean                  not null default true,
  "notes"              text,
  "created_at"         timestamp with time zone not null default now(),
  "created_by"         uuid,
  constraint "bob_signing_identities_created_by_fkey" foreign key (created_by) references auth.users(id),
  constraint "bob_signing_identities_fingerprint_sha256_key" unique (fingerprint_sha256),
  constraint "bob_signing_identities_pkey" primary key (id),
  constraint "bob_signing_identities_provider_check" check ((provider = 'gitea'::text))
);

alter table "public"."bob_signing_identities"
  enable row level security;

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."bob_signing_identities" to "postgres", "service_role";
