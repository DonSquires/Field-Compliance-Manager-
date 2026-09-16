-- Pre-migration fixture for 20260916140000. This file is supplied before the candidate migration.
SET search_path TO public, extensions, pg_catalog;

INSERT INTO public.organizations (id, name, organization_type)
VALUES ('a1400000-0000-4000-8000-000000000001', 'T_CCTV_BACKFILL_ORG', 'service_provider');

INSERT INTO public.locations (id, organization_id, name, address)
VALUES ('a1400000-0000-4000-8000-000000000010', 'a1400000-0000-4000-8000-000000000001', 'T CCTV Backfill House', '140 Review Ready Road');

INSERT INTO public.cctv_imports (id, organization_id, location_id, canonical_place_id, camera_label, camera_key, status)
SELECT 'a1400000-0000-4000-8000-000000000100', l.organization_id, l.id, l.canonical_place_id, 'All terminal', 't-backfill-terminal', 'registered'
FROM public.locations AS l WHERE l.id = 'a1400000-0000-4000-8000-000000000010';
INSERT INTO public.cctv_imports (id, organization_id, location_id, canonical_place_id, camera_label, camera_key, status)
SELECT 'a1400000-0000-4000-8000-000000000101', l.organization_id, l.id, l.canonical_place_id, 'Mixed jobs', 't-backfill-mixed', 'registered'
FROM public.locations AS l WHERE l.id = 'a1400000-0000-4000-8000-000000000010';
INSERT INTO public.cctv_imports (id, organization_id, location_id, canonical_place_id, camera_label, camera_key, status)
SELECT 'a1400000-0000-4000-8000-000000000102', l.organization_id, l.id, l.canonical_place_id, 'Archived', 't-backfill-archived', 'archived'
FROM public.locations AS l WHERE l.id = 'a1400000-0000-4000-8000-000000000010';

INSERT INTO public.evidence_items (id, organization_id, module_key, evidence_kind, storage_path, cctv_import_id)
VALUES
  ('a1400000-0000-4000-8000-000000000201', 'a1400000-0000-4000-8000-000000000001', 'cctv_review', 'video', 'org/t/terminal-a.mp4', 'a1400000-0000-4000-8000-000000000100'),
  ('a1400000-0000-4000-8000-000000000202', 'a1400000-0000-4000-8000-000000000001', 'cctv_review', 'video', 'org/t/terminal-b.mp4', 'a1400000-0000-4000-8000-000000000100'),
  ('a1400000-0000-4000-8000-000000000203', 'a1400000-0000-4000-8000-000000000001', 'cctv_review', 'video', 'org/t/mixed-a.mp4', 'a1400000-0000-4000-8000-000000000101'),
  ('a1400000-0000-4000-8000-000000000204', 'a1400000-0000-4000-8000-000000000001', 'cctv_review', 'video', 'org/t/mixed-b.mp4', 'a1400000-0000-4000-8000-000000000101'),
  ('a1400000-0000-4000-8000-000000000205', 'a1400000-0000-4000-8000-000000000001', 'cctv_review', 'video', 'org/t/archived.mp4', 'a1400000-0000-4000-8000-000000000102');

INSERT INTO public.inference_jobs (id, organization_id, evidence_item_id, domain, status)
VALUES
  ('a1400000-0000-4000-8000-000000000301', 'a1400000-0000-4000-8000-000000000001', 'a1400000-0000-4000-8000-000000000201', 'video_motion', 'complete'),
  ('a1400000-0000-4000-8000-000000000302', 'a1400000-0000-4000-8000-000000000001', 'a1400000-0000-4000-8000-000000000202', 'video_motion', 'manual_review_required'),
  ('a1400000-0000-4000-8000-000000000303', 'a1400000-0000-4000-8000-000000000001', 'a1400000-0000-4000-8000-000000000203', 'video_motion', 'complete'),
  ('a1400000-0000-4000-8000-000000000304', 'a1400000-0000-4000-8000-000000000001', 'a1400000-0000-4000-8000-000000000204', 'video_motion', 'processing'),
  ('a1400000-0000-4000-8000-000000000305', 'a1400000-0000-4000-8000-000000000001', 'a1400000-0000-4000-8000-000000000205', 'video_motion', 'complete');
