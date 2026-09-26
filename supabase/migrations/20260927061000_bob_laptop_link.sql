-- Bob's laptop link registry (owner instruction 2026-09-26: the laptop is on Tailscale and
-- already carries deploy/laptop-worker/laptop-worker.env with the project's service key).
--
-- scripts/bob-gpu-link/laptop-tailscale.ps1 registers the laptop here each time it runs
-- (Tailscale address, Windows user name Bob logs in as, whether the owner's SSH switch is on,
-- the Ollama models present), so the control plane learns how to reach Bob's terminal and GPU
-- without the owner copying values across by hand. Service role only: no anon/authenticated
-- access, no policies. Non-evidential Bob machinery.

CREATE TABLE IF NOT EXISTS public.bob_laptop_link (
  id text PRIMARY KEY DEFAULT 'primary',
  host_name text NOT NULL,
  tailscale_ip inet NOT NULL,
  windows_user text NOT NULL,
  ssh_allowed boolean NOT NULL DEFAULT false,
  ssh_port integer NOT NULL DEFAULT 22 CHECK (ssh_port BETWEEN 1 AND 65535),
  ollama_host text,
  ollama_models text[] NOT NULL DEFAULT '{}',
  gpu text,
  script_version text,
  reported_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.bob_laptop_link IS 'Owner laptop(s) Bob may use over Tailscale: GPU (Ollama) and an owner-switched PowerShell terminal. Written by scripts/bob-gpu-link/laptop-tailscale.ps1 with the service key from laptop-worker.env; read by the control plane (bob-laptop-shell.js). Service role only.';

ALTER TABLE public.bob_laptop_link ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.bob_laptop_link FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.bob_laptop_link TO service_role;

CREATE OR REPLACE FUNCTION public.bob_laptop_link_touch()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS bob_laptop_link_touch ON public.bob_laptop_link;
CREATE TRIGGER bob_laptop_link_touch BEFORE UPDATE ON public.bob_laptop_link
  FOR EACH ROW EXECUTE FUNCTION public.bob_laptop_link_touch();
