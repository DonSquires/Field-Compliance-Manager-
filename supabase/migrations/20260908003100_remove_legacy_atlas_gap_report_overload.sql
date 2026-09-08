-- The original two-argument gap report must not shadow the triage-aware contract.

drop function if exists public.bob_atlas_gap_report(integer, integer);
