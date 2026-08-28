create table "public"."bob_signing_nonces" (
  "nonce"      text                     not null,
  "expires_at" timestamp with time zone not null,
  "created_at" timestamp with time zone not null default now(),
  constraint "bob_signing_nonces_pkey" primary key (nonce)
);

alter table "public"."bob_signing_nonces"
  enable row level security;

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."bob_signing_nonces" to "anon", "authenticated", "postgres", "service_role";
