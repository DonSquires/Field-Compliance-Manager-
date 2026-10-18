-- Owner direction 2026-10-18: Ollama Cloud (the owner's ollama.com subscription) is
-- the first outsourced model tier for Bob Builder, after the laptop GPU and the VPS
-- Ollama and before per-call OpenAI. Model-run provenance must name the provider
-- that actually did the work, so the provider check admits 'ollama_cloud'.
-- Restricted (local-only) work never routes to it; that is enforced in the router.

ALTER TABLE public.builder_model_runs DROP CONSTRAINT IF EXISTS builder_model_runs_provider_check;
ALTER TABLE public.builder_model_runs
  ADD CONSTRAINT builder_model_runs_provider_check
  CHECK (provider IN ('openai', 'ollama', 'gpu_workstation', 'ollama_cloud'));
