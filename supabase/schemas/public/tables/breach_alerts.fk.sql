-- Foreign keys in a cross-table reference cycle are split out of their
-- table's file: each file loads atomically, so keeping them inline would
-- deadlock the loader (every file would need a table another pending file
-- creates). These statements apply once all referenced tables exist.

alter table "public"."breach_alerts"
  add constraint "breach_alerts_overnight_session_id_fkey" foreign key (overnight_session_id) references public.vehicle_overnight_sessions(id) on delete set null;
