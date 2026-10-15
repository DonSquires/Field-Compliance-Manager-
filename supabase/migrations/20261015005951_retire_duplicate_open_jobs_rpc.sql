-- Dispatch jobs and shift coverage have separate canonical workflows, states,
-- permissions and receipts. This uncalled mixed queue was a legacy duplicate.
DROP FUNCTION IF EXISTS public.get_open_jobs(integer, integer);