-- Auto model routing: one provider's model list must not crowd every other provider out of the
-- candidate slots. Live evidence 2026-11-11: six untried Ollama Cloud models each started on a fresh
-- prior, filled max_candidates for product analysis, and Anthropic (healthy) was never tried.
alter table public.bob_model_routing_policies
  add column if not exists max_per_provider integer not null default 2
    check (max_per_provider between 1 and 20);

comment on column public.bob_model_routing_policies.max_per_provider is
  'Most candidates one provider may take before every other permitted provider has had a slot.';
