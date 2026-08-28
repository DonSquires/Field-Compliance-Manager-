-- Foreign keys in a cross-table reference cycle are split out of their
-- table's file: each file loads atomically, so keeping them inline would
-- deadlock the loader (every file would need a table another pending file
-- creates). These statements apply once all referenced tables exist.

alter table "public"."shift_stops"
  add constraint "shift_stops_dispatch_job_id_fkey" foreign key (dispatch_job_id) references public.dispatch_jobs(id) on delete set null;
