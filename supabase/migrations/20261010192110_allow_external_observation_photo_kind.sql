BEGIN;

ALTER TABLE public.observation_supporting_evidence
  DROP CONSTRAINT IF EXISTS observation_supporting_evidence_evidence_kind_check;

ALTER TABLE public.observation_supporting_evidence
  ADD CONSTRAINT observation_supporting_evidence_evidence_kind_check
  CHECK (evidence_kind IN (
    'scv_sticker',
    'signage',
    'permit',
    'vehicle_detail',
    'scene_context',
    'external_photo',
    'other'
  ));

COMMENT ON COLUMN public.observation_supporting_evidence.evidence_kind IS
  'Supporting evidence classification. external_photo is provenance-bearing historical or externally supplied photo evidence and is not court-ready by default.';

COMMIT;