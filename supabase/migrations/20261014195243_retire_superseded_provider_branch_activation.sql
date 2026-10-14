-- create_provider_branch now creates an active, immediately usable operating
-- branch and inherits the parent provider's enabled modules. The older
-- prospect-to-active transition is therefore unreachable from the governed
-- organization setup flow and represents a second branch lifecycle authority.

DROP FUNCTION IF EXISTS public.activate_provider_branch(uuid, timestamptz);