-- Foreign keys in a cross-table reference cycle are split out of their
-- table's file: each file loads atomically, so keeping them inline would
-- deadlock the loader (every file would need a table another pending file
-- creates). These statements apply once all referenced tables exist.

alter table "public"."vehicle_overnight_sessions"
  add constraint "vehicle_overnight_sessions_breach_alert_id_fkey" foreign key (breach_alert_id) references public.breach_alerts(id);
