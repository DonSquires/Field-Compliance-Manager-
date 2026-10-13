alter table public.bob_app_map_edges
  drop constraint if exists bob_app_map_edges_evidence_class_check;

alter table public.bob_app_map_edges
  add constraint bob_app_map_edges_evidence_class_check
  check ((evidence_class = any (array[
    'live-code'::text,
    'live-schema'::text,
    'exercised-records'::text,
    'authored-expectation'::text,
    'inferred-gap'::text,
    'declared-external-contract'::text
  ])));