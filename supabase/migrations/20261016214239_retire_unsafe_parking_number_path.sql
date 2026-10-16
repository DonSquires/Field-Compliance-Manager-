-- The production notice generators use reserve_infringement_notice_number(),
-- which checks organization access and atomically increments the canonical
-- module-scoped counter. This predecessor used MAX(notice_number) + 1 and could
-- issue duplicates under concurrent field activity.
DROP FUNCTION IF EXISTS public.generate_parking_notice_number(uuid);

-- This older generic counter table has no live records or writers. The active
-- parking counter is public.infringement_notice_counters.
DROP TABLE IF EXISTS public.notice_counters;