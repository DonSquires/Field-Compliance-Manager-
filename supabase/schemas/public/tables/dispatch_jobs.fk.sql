-- Foreign keys in a cross-table reference cycle are split out of their
-- table's file: each file loads atomically, so keeping them inline would
-- deadlock the loader (every file would need a table another pending file
-- creates). These statements apply once all referenced tables exist.

alter table "public"."dispatch_jobs"
  add constraint "dispatch_jobs_shift_stop_id_fkey" foreign key (shift_stop_id) references public.shift_stops(id) on delete set null;
