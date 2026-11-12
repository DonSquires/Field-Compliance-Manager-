-- BB-186: the model router escalates to any active bob_model_catalog provider
-- (anthropic, omniroute, vps_ollama, ...), but builder_model_runs only accepted
-- four hard-coded providers, so every receipt for another provider was rejected
-- and the agentic author crashed. The catalogue is the authority for which
-- providers exist; the column only enforces a well-formed provider key.
alter table public.builder_model_runs
  drop constraint if exists builder_model_runs_provider_check;

alter table public.builder_model_runs
  add constraint builder_model_runs_provider_check
  check (provider ~ '^[a-z][a-z0-9_]{1,62}$') not valid;

alter table public.builder_model_runs
  validate constraint builder_model_runs_provider_check;
