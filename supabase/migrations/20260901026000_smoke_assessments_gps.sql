-- Smoke control spec compliance (#smoke-not-to-spec): assessment must be
-- anchored by GPS, per Bob's module_smoke_control / workflow_smoke_control
-- knowledge cards ("smoke_assessments row (location, description, evidence
-- photo)"). smoke_assessments had photo_urls/bob_classification/
-- bob_confidence/bob_recommendation columns already, but no GPS point at
-- all -- add it, mirroring assessment_gps_lat/lng on noise_assessments.

alter table public.smoke_assessments
  add column if not exists gps_lat double precision,
  add column if not exists gps_lng double precision;

comment on column public.smoke_assessments.gps_lat is 'Officer GPS latitude captured at the time of the smoke observation.';
comment on column public.smoke_assessments.gps_lng is 'Officer GPS longitude captured at the time of the smoke observation.';
