-- Bob's own memory has been silently empty. bob_self_memory_memory_kind_check allowed only the
-- reflective kinds (reflection, good_day, hard_day, lesson, observation, gratitude), so the
-- Builder engineer's per-run note (kind builder_note, added 2026-09-26) failed on every insert —
-- the error was swallowed and read_notes returned nothing — and the release lane's 'deployment'
-- note would fail the same way. Widen the list; nothing else about the table changes.

ALTER TABLE public.bob_self_memory DROP CONSTRAINT IF EXISTS bob_self_memory_memory_kind_check;
ALTER TABLE public.bob_self_memory ADD CONSTRAINT bob_self_memory_memory_kind_check
  CHECK (memory_kind = ANY (ARRAY['reflection'::text, 'good_day'::text, 'hard_day'::text, 'lesson'::text, 'observation'::text, 'gratitude'::text, 'builder_note'::text, 'deployment'::text]));
