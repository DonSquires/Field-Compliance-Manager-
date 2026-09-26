-- Bob's Builder lane now routes model work in-house first (owner ruling 2026-09-26):
-- the laptop GPU ('gpu_workstation') and the VPS Ollama ('ollama') are Bob's own
-- compute; OpenAI is the outsourced fallback for when he is stuck. Model-run
-- provenance must name the provider that actually did the work, and the
-- independent-review rule (reviewer identity != author identity) compares
-- provider + model, so the provider check needs the new name.

ALTER TABLE public.builder_model_runs DROP CONSTRAINT IF EXISTS builder_model_runs_provider_check;
ALTER TABLE public.builder_model_runs
  ADD CONSTRAINT builder_model_runs_provider_check
  CHECK (provider IN ('openai', 'ollama', 'gpu_workstation'));
