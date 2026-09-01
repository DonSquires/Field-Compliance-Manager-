alter table public.geofence_boundary_history drop constraint geofence_boundary_history_changed_via_check;
alter table public.geofence_boundary_history add constraint geofence_boundary_history_changed_via_check
  check(changed_via in('governed_proposal','direct_edit','admin_upload','reconciliation','refresh','verification','backfill'));