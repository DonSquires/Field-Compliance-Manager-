-- Evidence is shared across modules, but its durable place context must be
-- inherited from the canonical event when one exists. Nullable preserves old
-- uploads and non-event reference material while future writers attach it.
ALTER TABLE public.evidence_items
  ADD COLUMN IF NOT EXISTS location_event_id uuid REFERENCES public.location_events(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_evidence_items_location_event
  ON public.evidence_items (location_event_id)
  WHERE location_event_id IS NOT NULL;

COMMENT ON COLUMN public.evidence_items.location_event_id IS
  'Canonical physical event this evidence supports. Event context, not captured_by_user_id or organization_id alone, is the durable place provenance.';
