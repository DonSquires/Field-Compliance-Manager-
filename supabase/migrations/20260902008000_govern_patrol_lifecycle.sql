alter table public.patrol_checkpoint_visits
  alter column checkpoint_id drop not null,
  add column if not exists route_checkpoint_id uuid references public.patrol_route_checkpoints(id);

alter table public.patrol_checkpoint_visits drop constraint if exists patrol_checkpoint_visits_one_checkpoint_chk;
alter table public.patrol_checkpoint_visits add constraint patrol_checkpoint_visits_one_checkpoint_chk check(num_nonnulls(checkpoint_id,route_checkpoint_id)=1);
alter table public.patrol_checkpoint_visits drop constraint if exists patrol_checkpoint_visits_scan_method_check;
alter table public.patrol_checkpoint_visits add constraint patrol_checkpoint_visits_scan_method_check check(scan_method in('gps','qr_camera','nfc','manual_code','url_deep_link'));
create index if not exists idx_pcv_route_checkpoint_id on public.patrol_checkpoint_visits(route_checkpoint_id) where route_checkpoint_id is not null;

create or replace function public.start_patrol_session(p_shift_id uuid)
returns public.patrols language plpgsql security definer set search_path=public as $$
declare v_actor uuid:=auth.uid();v_profile public.user_profiles%rowtype;v_shift public.shifts%rowtype;v_patrol public.patrols%rowtype;
begin
  if v_actor is null then raise exception 'Authentication required';end if;
  select * into v_profile from public.user_profiles where id=v_actor and deactivated_at is null;
  if not found or v_profile.role not in('grand_master','master','admin','admin_officer','officer') then raise exception 'Active Patrol officer required';end if;
  select * into v_shift from public.shifts where id=p_shift_id for update;
  if not found or v_shift.organization_id is distinct from v_profile.organization_id or v_shift.officer_user_id is distinct from v_actor then raise exception 'Assigned Patrol shift not found';end if;
  if v_shift.status not in('published','accepted','in_progress') then raise exception 'Patrol shift is not active';end if;
  select * into v_patrol from public.patrols where shift_id=v_shift.id and officer_user_id=v_actor and status='in_progress' order by started_at desc limit 1;
  if found then return v_patrol;end if;
  insert into public.patrols(organization_id,shift_id,officer_user_id,zone_id,status,started_at) values(v_shift.organization_id,v_shift.id,v_actor,v_shift.zone_id,'in_progress',clock_timestamp()) returning * into v_patrol;
  insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata) values(v_patrol.organization_id,v_actor,'patrol.started','patrols',v_patrol.id,jsonb_build_object('shift_id',v_shift.id,'patrol_route_id',v_shift.patrol_route_id));
  return v_patrol;
end;$$;

create or replace function public.record_patrol_checkpoint_visit(p_patrol_id uuid,p_checkpoint_kind text,p_checkpoint_id uuid,p_gps_lat double precision,p_gps_lng double precision,p_gps_accuracy double precision,p_notes text default null)
returns table(visit_id uuid,created boolean,visited_at timestamptz,scan_method text,notes text) language plpgsql security definer set search_path=public as $$
declare
  v_actor uuid:=auth.uid();v_profile public.user_profiles%rowtype;v_patrol record;v_checkpoint record;v_existing public.patrol_checkpoint_visits%rowtype;v_visit public.patrol_checkpoint_visits%rowtype;
  v_radius double precision;v_distance double precision;v_shift_stop_id uuid;v_regular_id uuid;v_route_id uuid;
begin
  if v_actor is null then raise exception 'Authentication required';end if;
  select * into v_profile from public.user_profiles where id=v_actor and deactivated_at is null;
  if not found or v_profile.role not in('grand_master','master','admin','admin_officer','officer') then raise exception 'Active Patrol officer required';end if;
  select p.*,s.patrol_route_id,s.zone_id as shift_zone_id into v_patrol from public.patrols p join public.shifts s on s.id=p.shift_id where p.id=p_patrol_id for update of p;
  if not found or v_patrol.organization_id is distinct from v_profile.organization_id or v_patrol.officer_user_id is distinct from v_actor then raise exception 'Active assigned Patrol session not found';end if;
  if v_patrol.status<>'in_progress' then raise exception 'Patrol session is not in progress';end if;
  if p_gps_lat is null or p_gps_lng is null or p_gps_accuracy is null or p_gps_lat not between -90 and 90 or p_gps_lng not between -180 and 180 or p_gps_accuracy<0 or p_gps_accuracy>1000 then raise exception 'Valid checkpoint GPS and accuracy are required';end if;
  if p_checkpoint_kind='route' then
    select id,gps_lat,gps_lng,geofence_radius_meters as radius,patrol_route_id,is_active,null::uuid as client_site_id,null::uuid as zone_id into v_checkpoint from public.patrol_route_checkpoints where id=p_checkpoint_id;
    if not found or not v_checkpoint.is_active or v_checkpoint.patrol_route_id is distinct from v_patrol.patrol_route_id then raise exception 'Assigned route checkpoint not found';end if;
    v_route_id:=v_checkpoint.id;
  elsif p_checkpoint_kind='site' then
    select id,gps_lat,gps_lng,radius_meters as radius,null::uuid as patrol_route_id,active as is_active,client_site_id,zone_id into v_checkpoint from public.patrol_checkpoints where id=p_checkpoint_id and organization_id=v_patrol.organization_id;
    if not found or not v_checkpoint.is_active or not((v_checkpoint.zone_id is not null and v_checkpoint.zone_id=v_patrol.shift_zone_id) or exists(select 1 from public.shift_stops st where st.shift_id=v_patrol.shift_id and((v_checkpoint.client_site_id is not null and st.site_id=v_checkpoint.client_site_id)or(v_checkpoint.zone_id is not null and st.zone_id=v_checkpoint.zone_id)))) then raise exception 'Assigned Patrol checkpoint not found';end if;
    v_regular_id:=v_checkpoint.id;
    select st.id into v_shift_stop_id from public.shift_stops st where st.shift_id=v_patrol.shift_id and(st.site_id=v_checkpoint.client_site_id or st.zone_id=v_checkpoint.zone_id) and st.status not in('completed','skipped','cancelled') order by st.stop_order limit 1;
  else raise exception 'Checkpoint kind must be route or site';end if;
  if v_checkpoint.gps_lat is null or v_checkpoint.gps_lng is null then raise exception 'Checkpoint has no verified GPS anchor';end if;
  v_radius:=greatest(coalesce(v_checkpoint.radius,0),1);
  if p_gps_accuracy>v_radius then raise exception 'GPS accuracy is too poor for this checkpoint';end if;
  v_distance:=st_distance(st_setsrid(st_makepoint(p_gps_lng,p_gps_lat),4326)::geography,st_setsrid(st_makepoint(v_checkpoint.gps_lng,v_checkpoint.gps_lat),4326)::geography);
  if v_distance>v_radius then raise exception 'GPS position is outside the checkpoint radius';end if;
  perform pg_advisory_xact_lock(hashtextextended(p_patrol_id::text||':'||p_checkpoint_kind||':'||p_checkpoint_id::text,0));
  select * into v_existing from public.patrol_checkpoint_visits where patrol_id=p_patrol_id and((p_checkpoint_kind='route' and route_checkpoint_id=p_checkpoint_id)or(p_checkpoint_kind='site' and checkpoint_id=p_checkpoint_id)) order by visited_at limit 1;
  if found then return query select v_existing.id,false,v_existing.visited_at,v_existing.scan_method,v_existing.notes;return;end if;
  insert into public.patrol_checkpoint_visits(organization_id,patrol_id,checkpoint_id,route_checkpoint_id,officer_user_id,gps_lat,gps_lng,gps_accuracy,gps_distance_from_checkpoint,within_radius,scan_method,notes,shift_stop_id)
  values(v_patrol.organization_id,v_patrol.id,v_regular_id,v_route_id,v_actor,p_gps_lat,p_gps_lng,p_gps_accuracy,v_distance,true,'gps',nullif(trim(coalesce(p_notes,'')),''),v_shift_stop_id) returning * into v_visit;
  insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata) values(v_visit.organization_id,v_actor,'patrol.checkpoint_recorded','patrol_checkpoint_visits',v_visit.id,jsonb_build_object('patrol_id',v_visit.patrol_id,'checkpoint_kind',p_checkpoint_kind,'checkpoint_id',p_checkpoint_id,'distance_metres',round(v_distance::numeric,1),'shift_stop_id',v_shift_stop_id));
  return query select v_visit.id,true,v_visit.visited_at,v_visit.scan_method,v_visit.notes;
end;$$;

create or replace function public.complete_patrol_session(p_patrol_id uuid,p_notes text default null)
returns public.patrols language plpgsql security definer set search_path=public as $$
declare v_actor uuid:=auth.uid();v_profile public.user_profiles%rowtype;v_patrol record;v_result public.patrols%rowtype;
begin
  if v_actor is null then raise exception 'Authentication required';end if;
  select * into v_profile from public.user_profiles where id=v_actor and deactivated_at is null;
  if not found or v_profile.role not in('grand_master','master','admin','admin_officer','officer') then raise exception 'Active Patrol officer required';end if;
  select p.*,s.patrol_route_id,s.zone_id as shift_zone_id into v_patrol from public.patrols p join public.shifts s on s.id=p.shift_id where p.id=p_patrol_id for update of p;
  if not found or v_profile.organization_id is distinct from v_patrol.organization_id or v_patrol.officer_user_id is distinct from v_actor then raise exception 'Active assigned Patrol session not found';end if;
  if v_patrol.status='completed' then select * into v_result from public.patrols where id=p_patrol_id;return v_result;end if;
  if v_patrol.status<>'in_progress' then raise exception 'Patrol session is not in progress';end if;
  if exists(select 1 from public.patrol_route_checkpoints c where c.patrol_route_id=v_patrol.patrol_route_id and c.is_active and c.is_mandatory and not exists(select 1 from public.patrol_checkpoint_visits v where v.patrol_id=v_patrol.id and v.route_checkpoint_id=c.id)) then raise exception 'One or more mandatory checkpoints remain';end if;
  if not exists(select 1 from public.patrol_route_checkpoints c where c.patrol_route_id=v_patrol.patrol_route_id and c.is_active and c.is_mandatory) and exists(select 1 from public.patrol_checkpoints c where c.active and((c.zone_id is not null and c.zone_id=v_patrol.shift_zone_id)or exists(select 1 from public.shift_stops st where st.shift_id=v_patrol.shift_id and((c.client_site_id is not null and st.site_id=c.client_site_id)or(c.zone_id is not null and st.zone_id=c.zone_id))))and not exists(select 1 from public.patrol_checkpoint_visits v where v.patrol_id=v_patrol.id and v.checkpoint_id=c.id)) then raise exception 'One or more mandatory checkpoints remain';end if;
  update public.patrols set status='completed',ended_at=clock_timestamp(),notes=coalesce(nullif(trim(coalesce(p_notes,'')),''),notes) where id=v_patrol.id returning * into v_result;
  insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata) values(v_result.organization_id,v_actor,'patrol.completed','patrols',v_result.id,jsonb_build_object('shift_id',v_result.shift_id,'checkpoint_count',(select count(*) from public.patrol_checkpoint_visits where patrol_id=v_result.id)));
  return v_result;
end;$$;

revoke insert,update,delete on table public.patrols,public.patrol_checkpoint_visits from public,anon,authenticated;
revoke all on function public.start_patrol_session(uuid),public.record_patrol_checkpoint_visit(uuid,text,uuid,double precision,double precision,double precision,text),public.complete_patrol_session(uuid,text) from public,anon;
grant execute on function public.start_patrol_session(uuid),public.record_patrol_checkpoint_visit(uuid,text,uuid,double precision,double precision,double precision,text),public.complete_patrol_session(uuid,text) to authenticated,service_role;