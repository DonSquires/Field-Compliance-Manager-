create table "public"."bob_action_approvals" (
  "id"                uuid                     not null default gen_random_uuid(),
  "conversation_id"   text                     not null,
  "request_id"        text                     not null,
  "tool_execution_id" uuid                     not null,
  "approval_scope"    text                     not null,
  "status"            text                     not null,
  "proposed_action"   jsonb                    not null,
  "approved_by"       uuid,
  "approved_at"       timestamp with time zone,
  "rejected_by"       uuid,
  "rejected_at"       timestamp with time zone,
  "expires_at"        timestamp with time zone,
  "created_at"        timestamp with time zone not null default now(),
  constraint "bob_action_approvals_approval_scope_check" check ((approval_scope = ANY (ARRAY['write'::text, 'destructive'::text, 'deploy'::text, 'secret'::text]))),
  constraint "bob_action_approvals_approved_by_fkey" foreign key (approved_by) references auth.users(id),
  constraint "bob_action_approvals_pkey" primary key (id),
  constraint "bob_action_approvals_rejected_by_fkey" foreign key (rejected_by) references auth.users(id),
  constraint "bob_action_approvals_status_check" check ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text, 'expired'::text]))),
  constraint "bob_action_approvals_tool_execution_id_fkey" foreign key (tool_execution_id) references public.bob_tool_executions(id) on delete cascade
);

alter table "public"."bob_action_approvals"
  enable row level security;

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."bob_action_approvals" to "anon", "authenticated", "postgres", "service_role";
