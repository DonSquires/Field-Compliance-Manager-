-- Data-driven model routing for Bob Builder, Vibe Builder and in-app Bob (owner direction 2026-11-10:
-- "the right agent is selected for the job instead of hard coding it"). The router
-- (services/fcm-api/src/bob/modelRouter.js) ranks reachable provider/models per job from:
--   bob_model_catalog           capability priors, cost tier and privacy class per provider/model
--   bob_model_task_classes      workload kind / prompt family / in-app role -> task class
--   bob_model_routing_policies  per surface and task class weights and limits (platform or org)
--   bob_model_route_stats()     observed outcomes from builder_model_runs
-- Restricted data stays on local models in code whatever these rows say. Rows are owner-tunable data;
-- the seeded qualities are priors that observed success outweighs as runs accumulate.

create table if not exists public.bob_model_catalog (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider ~ '^[a-z][a-z0-9_]{1,40}$'),
  model_name text not null default '*' check (length(model_name) between 1 and 120),
  privacy_class text not null check (privacy_class in ('local', 'external')),
  cost_tier smallint not null check (cost_tier between 0 and 3),
  base_quality numeric(4,3) not null default 0.5 check (base_quality between 0 and 1),
  task_quality jsonb not null default '{}'::jsonb check (jsonb_typeof(task_quality) = 'object'),
  active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, model_name)
);
comment on table public.bob_model_catalog is 'Model routing catalogue: model_name ''*'' is the provider default. cost_tier 0 owned compute, 1 flat subscription, 2 metered, 3 metered premium. task_quality maps task_class -> 0..1 prior.';

create table if not exists public.bob_model_task_classes (
  match_kind text not null check (match_kind in ('workload_kind', 'prompt_family', 'role')),
  match_value text not null check (length(match_value) between 1 and 80),
  task_class text not null check (task_class ~ '^[a-z][a-z0-9_]{1,40}$'),
  created_at timestamptz not null default now(),
  primary key (match_kind, match_value)
);
comment on table public.bob_model_task_classes is 'Maps a Builder workload kind, a prompt family (prompt_version without -vN) or an in-app Bob role to a routing task class.';

create table if not exists public.bob_model_routing_policies (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations(id) on delete cascade,
  surface text not null check (surface in ('*', 'builder', 'vibe', 'in_app')),
  task_class text not null default '*' check (task_class = '*' or task_class ~ '^[a-z][a-z0-9_]{1,40}$'),
  allow_external boolean not null default true,
  max_cost_tier smallint not null default 3 check (max_cost_tier between 0 and 3),
  excluded_providers text[] not null default '{}',
  weights jsonb not null default '{"quality":0.3,"success":0.4,"cost":0.2,"latency":0.1}'::jsonb
    check (jsonb_typeof(weights) = 'object'),
  prior_strength numeric(6,2) not null default 6 check (prior_strength > 0),
  max_candidates smallint not null default 6 check (max_candidates between 1 and 12),
  active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.bob_model_routing_policies is 'Routing policy per surface/task class; the most specific active row wins (org over platform, surface over *, task over *).';
create unique index if not exists bob_model_routing_policies_scope_key
  on public.bob_model_routing_policies (coalesce(organization_id, '00000000-0000-0000-0000-000000000000'::uuid), surface, task_class);
create index if not exists bob_model_routing_policies_org_idx
  on public.bob_model_routing_policies (organization_id) where organization_id is not null;
create index if not exists idx_builder_model_runs_created_at
  on public.builder_model_runs (created_at);

alter table public.bob_model_catalog enable row level security;
alter table public.bob_model_task_classes enable row level security;
alter table public.bob_model_routing_policies enable row level security;
drop policy if exists bob_model_catalog_service_role on public.bob_model_catalog;
create policy bob_model_catalog_service_role on public.bob_model_catalog
  to service_role using (true) with check (true);
drop policy if exists bob_model_task_classes_service_role on public.bob_model_task_classes;
create policy bob_model_task_classes_service_role on public.bob_model_task_classes
  to service_role using (true) with check (true);
drop policy if exists bob_model_routing_policies_service_role on public.bob_model_routing_policies;
create policy bob_model_routing_policies_service_role on public.bob_model_routing_policies
  to service_role using (true) with check (true);
revoke all on public.bob_model_catalog, public.bob_model_task_classes, public.bob_model_routing_policies from public, anon, authenticated;
grant select, insert, update, delete on public.bob_model_catalog, public.bob_model_task_classes, public.bob_model_routing_policies to service_role;

-- Observed outcomes per provider/model/task class over a bounded window. Only finished runs count.
create or replace function public.bob_model_route_stats(p_days integer default 30)
returns table (provider text, model_name text, task_class text, runs bigint, completed bigint, avg_seconds numeric)
language sql
stable
security definer
set search_path = public
as $$
  select r.provider,
         r.model_name,
         coalesce(tc.task_class, 'general') as task_class,
         count(*) as runs,
         count(*) filter (where r.status = 'completed') as completed,
         round(avg(extract(epoch from (r.completed_at - r.started_at)))
           filter (where r.completed_at is not null and r.started_at is not null)::numeric, 1) as avg_seconds
    from public.builder_model_runs r
    left join public.bob_model_task_classes tc
      on tc.match_kind = 'prompt_family'
     and tc.match_value = regexp_replace(r.prompt_version, '-v[0-9]+$', '')
   where r.created_at > now() - make_interval(days => greatest(1, least(coalesce(p_days, 30), 180)))
     and r.status in ('completed', 'failed', 'timeout')
   group by 1, 2, 3
$$;
revoke all on function public.bob_model_route_stats(integer) from public, anon, authenticated;
grant execute on function public.bob_model_route_stats(integer) to service_role;

insert into public.bob_model_task_classes (match_kind, match_value, task_class) values
  ('workload_kind', 'file_classification', 'light'),
  ('workload_kind', 'redaction_assistance', 'light'),
  ('workload_kind', 'repository_summary', 'light'),
  ('workload_kind', 'simple_documentation', 'light'),
  ('workload_kind', 'release_preparation', 'light'),
  ('workload_kind', 'backend_implementation', 'author'),
  ('workload_kind', 'frontend_implementation', 'author'),
  ('workload_kind', 'frontend_repair', 'author'),
  ('workload_kind', 'vibe_implementation', 'author'),
  ('workload_kind', 'independent_code_review', 'review'),
  ('workload_kind', 'security_review', 'security'),
  ('workload_kind', 'product_analysis', 'analysis'),
  ('workload_kind', 'ux_design', 'analysis'),
  ('workload_kind', 'builder_conversation', 'conversation'),
  ('prompt_family', 'agentic-engineer', 'author'),
  ('prompt_family', 'backend-engineer', 'author'),
  ('prompt_family', 'frontend-engineer', 'author'),
  ('prompt_family', 'frontend-repair', 'author'),
  ('prompt_family', 'vibe', 'author'),
  ('prompt_family', 'independent-code-review', 'review'),
  ('prompt_family', 'product-analyst', 'analysis'),
  ('prompt_family', 'ux-designer', 'analysis'),
  ('prompt_family', 'release-engineer', 'light'),
  ('prompt_family', 'builder-chat', 'conversation'),
  ('prompt_family', 'builder-chat-cloud-pm', 'conversation'),
  ('role', 'planner', 'planning'),
  ('role', 'synthesis', 'planning'),
  ('role', 'verifier', 'review'),
  ('role', 'subagent', 'light')
on conflict (match_kind, match_value) do nothing;

insert into public.bob_model_catalog (provider, model_name, privacy_class, cost_tier, base_quality, task_quality, notes) values
  ('gpu_workstation', '*', 'local', 0, 0.55, '{"author":0.5,"review":0.5,"security":0.45,"analysis":0.55,"planning":0.55,"light":0.6,"conversation":0.6}', 'Owner laptop GPU (Ollama over the reverse link).'),
  ('ollama', '*', 'local', 0, 0.30, '{"light":0.45}', 'VPS CPU Ollama: restricted-data and embeddings tier; slow for long work.'),
  ('vps_ollama', '*', 'local', 0, 0.30, '{"light":0.45}', 'In-app name for the VPS CPU Ollama.'),
  ('ollama_cloud', '*', 'external', 1, 0.65, '{"author":0.65,"analysis":0.65}', 'Ollama Cloud flat-rate subscription.'),
  ('ollama_cloud', 'gpt-oss:120b', 'external', 1, 0.70, '{"author":0.72,"analysis":0.70}', null),
  ('ollama_cloud', 'kimi-k2.7-code', 'external', 1, 0.70, '{"author":0.75}', null),
  ('omniroute', '*', 'external', 1, 0.60, '{}', 'Owner-run OpenAI-compatible gateway; inert until configured.'),
  ('openai', '*', 'external', 2, 0.72, '{}', 'Metered OpenAI.'),
  ('openai', 'gpt-5.4-mini', 'external', 2, 0.70, '{}', null),
  ('openai', 'gpt-5.4', 'external', 3, 0.85, '{"review":0.85,"security":0.85}', null),
  ('openai', 'gpt-4o-mini', 'external', 2, 0.60, '{}', null),
  ('anthropic', '*', 'external', 3, 0.85, '{"security":0.95,"review":0.90,"author":0.88,"planning":0.88}', 'Metered Anthropic Claude.'),
  ('anthropic', 'claude-sonnet-5-5', 'external', 3, 0.90, '{"security":0.95,"review":0.92,"author":0.90,"planning":0.88}', null),
  ('anthropic', 'claude-haiku-5-5', 'external', 2, 0.72, '{"review":0.75,"light":0.75}', null)
on conflict (provider, model_name) do nothing;

insert into public.bob_model_routing_policies (organization_id, surface, task_class, weights, max_candidates, excluded_providers, notes) values
  (null, '*', '*', '{"quality":0.3,"success":0.4,"cost":0.2,"latency":0.1}', 6, '{}', 'Balanced platform default (owner choice 2026-11-10): best observed success per cost.'),
  (null, 'builder', 'author', '{"quality":0.3,"success":0.4,"cost":0.2,"latency":0.1}', 4, '{}', 'The agentic author splits its turn budget across candidates; keep the list short.'),
  (null, 'builder', 'review', '{"quality":0.45,"success":0.35,"cost":0.1,"latency":0.1}', 6, '{}', 'Independent review favours capability over cost.'),
  (null, 'builder', 'security', '{"quality":0.45,"success":0.35,"cost":0.1,"latency":0.1}', 6, '{}', 'Security review favours capability over cost.'),
  (null, 'builder', 'light', '{"quality":0.2,"success":0.3,"cost":0.4,"latency":0.1}', 6, '{}', 'Low-risk chores favour cheap models.'),
  (null, 'in_app', '*', '{"quality":0.3,"success":0.3,"cost":0.25,"latency":0.15}', 6, '{vps_ollama}', 'Chat turns are latency-bound; the VPS CPU is too slow for them (owner ruling 2026-09-26).')
on conflict do nothing;
