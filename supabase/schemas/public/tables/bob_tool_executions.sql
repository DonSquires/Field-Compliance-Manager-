create table "public"."bob_tool_executions" (
  "id"              uuid                     not null default gen_random_uuid(),
  "conversation_id" text                     not null,
  "request_id"      text                     not null,
  "step_index"      integer                  not null,
  "tool_key"        text                     not null,
  "decision_reason" text                     not null,
  "input_payload"   jsonb                    not null,
  "http_status"     integer,
  "ok"              boolean                  not null default false,
  "retryable"       boolean                  not null default false,
  "latency_ms"      integer,
  "output_payload"  jsonb,
  "error_code"      text,
  "error_message"   text,
  "created_at"      timestamp with time zone not null default now(),
  constraint "bob_tool_executions_pkey" primary key (id),
  constraint "bob_tool_executions_tool_key_fkey" foreign key (tool_key) references public.bob_tool_registry(tool_key)
);

alter table "public"."bob_tool_executions"
  enable row level security;

create index idx_bob_tool_exec_req on public.bob_tool_executions using btree (request_id, step_index);

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."bob_tool_executions" to "anon", "authenticated", "postgres", "service_role";
