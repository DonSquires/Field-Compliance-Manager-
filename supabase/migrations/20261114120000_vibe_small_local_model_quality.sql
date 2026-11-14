-- VB-15: a laptop 8B model was routed ahead of capable models for a Vibe code change because
-- per-model rows were missing, so qwen3:8b inherited the gpu_workstation provider default
-- (base 0.55, author 0.5). Catalogue the small local models at their observed authoring quality.
-- Additive: an operator-tuned row is never overwritten.
insert into public.bob_model_catalog (provider, model_name, privacy_class, cost_tier, base_quality, task_quality, active, notes)
values
  ('gpu_workstation', 'qwen3:8b', 'local', 0, 0.3, '{"author": 0.25, "light": 0.5, "conversation": 0.55}'::jsonb, true,
   'Small local model: good for light/conversational turns, weak at multi-file authoring (VB-15).'),
  ('gpu_workstation', 'qwen2.5-coder:7b', 'local', 0, 0.35, '{"author": 0.3, "light": 0.5}'::jsonb, true,
   'Small local coder: light edits and analysis only; capable models author code changes first.')
on conflict (provider, model_name) do nothing;
