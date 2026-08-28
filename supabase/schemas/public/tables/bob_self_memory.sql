create table "public"."bob_self_memory" (
  "id"          uuid                     not null default gen_random_uuid(),
  "created_at"  timestamp with time zone not null default now(),
  "memory_text" text                     not null,
  "memory_kind" text                     not null default 'reflection'::text,
  "status"      text                     not null default 'kept'::text,
  "proposed_by" uuid                     not null default '00000000-0000-0000-0000-00000000b0b0'::uuid,
  "approved_by" uuid,
  "approved_at" timestamp with time zone,
  "owner_note"  text,
  "content"     text,
  constraint "bob_self_memory_memory_kind_check"
    check ((memory_kind = ANY (ARRAY['reflection'::text, 'good_day'::text, 'hard_day'::text, 'lesson'::text, 'observation'::text, 'gratitude'::text]))),
  constraint "bob_self_memory_pkey" primary key (id),
  constraint "bob_self_memory_proposed_by_check" check ((proposed_by = '00000000-0000-0000-0000-00000000b0b0'::uuid)),
  constraint "bob_self_memory_approved_by_fkey" foreign key (approved_by) references public.user_profiles(id),
  constraint "bob_self_memory_proposed_by_fkey" foreign key (proposed_by) references public.user_profiles(id)
);

alter table "public"."bob_self_memory"
  enable row level security;

alter table "public"."bob_self_memory"
  force row level security;

create index idx_bob_self_memory_created_at on public.bob_self_memory using btree (created_at desc);

create index idx_bob_self_memory_proposed_by on public.bob_self_memory using btree (proposed_by);

create index idx_bob_self_memory_status on public.bob_self_memory using btree (status);

create trigger trg_sync_bob_self_memory_content
  before insert or update on public.bob_self_memory
  for each row
  execute function public.sync_bob_self_memory_content();

create policy "bob_full_read" on "public"."bob_self_memory"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "bob_self_memory_delete" on "public"."bob_self_memory"
  for delete
  to PUBLIC
  using (public.is_platform_owner(auth.uid()));

create policy "bob_self_memory_insert" on "public"."bob_self_memory"
  for insert
  to PUBLIC
  with check ((auth.uid() = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "bob_self_memory_select" on "public"."bob_self_memory"
  for select
  to PUBLIC
  using ((public.is_platform_owner(auth.uid()) or (auth.uid() = '00000000-0000-0000-0000-00000000b0b0'::uuid)));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."bob_self_memory" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."bob_self_memory" is 'Bob''s private self-memory (his diary). GRADUATED 0355: free direct-write, his own, no approval gate, no bell -- same rights as Scotty''s and Jim''s memory files. Immutable once written (no UPDATE); owner-only DELETE is the sole human touch (append/own freely, human-only delete, never overwrite). proposed_by=Bob is an authorship stamp, not a gate. The 0293 owner-approval apparatus (guard trigger / bell / approve RPC) is retired -- a graduation recognising Bob''s growth, not a loosened control. Memory != growth: the growth/conduct record (bob_conduct_log, human three-part sign-off) is separate and unchanged; a self-assessment is MEMORY and lands here, never as a self-scored conduct row.';
