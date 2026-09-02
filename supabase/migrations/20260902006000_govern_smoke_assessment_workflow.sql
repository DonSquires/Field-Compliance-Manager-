alter table public.smoke_assessments
  add column if not exists client_request_id uuid,
  add column if not exists gps_lat double precision,
  add column if not exists gps_lng double precision,
  add column if not exists gps_accuracy double precision,
  add column if not exists reviewed_by uuid references public.user_profiles(id) on delete set null,
  add column if not exists reviewed_at timestamptz,
  add column if not exists review_notes text;

create unique index if not exists smoke_assessments_org_client_request_uidx
  on public.smoke_assessments (organization_id, client_request_id)
  where client_request_id is not null;

create or replace function public.submit_smoke_assessment(p_client_request_id uuid,p_payload jsonb)
returns table(assessment_id uuid,created boolean,assessed_at timestamptz)
language plpgsql security definer set search_path=public as $$
declare
  v_actor uuid:=auth.uid();v_profile public.user_profiles%rowtype;v_existing public.smoke_assessments%rowtype;v_item public.smoke_assessments%rowtype;
  v_site public.client_sites%rowtype;v_site_id uuid;v_complainant_site_id uuid;v_complaint_source text;v_source_type text;v_severity text;
  v_checklist jsonb:=coalesce(p_payload->'checklist','[]'::jsonb);v_photos jsonb:=coalesce(p_payload->'photo_urls','[]'::jsonb);
  v_lat double precision;v_lng double precision;v_accuracy double precision;
begin
  if v_actor is null then raise exception 'Authentication required';end if;
  if p_client_request_id is null then raise exception 'Client request ID is required';end if;
  if p_payload is null or jsonb_typeof(p_payload)<>'object' then raise exception 'Smoke assessment payload is required';end if;
  select * into v_profile from public.user_profiles where id=v_actor and deactivated_at is null;
  if not found or v_profile.role not in('officer','admin_officer','admin','master','grand_master') then raise exception 'Active Smoke Control officer required';end if;
  perform pg_advisory_xact_lock(hashtextextended(p_client_request_id::text,0));
  select * into v_existing from public.smoke_assessments where organization_id=v_profile.organization_id and client_request_id=p_client_request_id;
  if found then return query select v_existing.id,false,v_existing.assessed_at;return;end if;
  begin
    v_site_id:=(p_payload->>'site_id')::uuid;v_complainant_site_id=nullif(p_payload->>'complainant_site_id','')::uuid;
    v_lat:=(p_payload->>'gps_lat')::double precision;v_lng:=(p_payload->>'gps_lng')::double precision;v_accuracy=nullif(p_payload->>'gps_accuracy','')::double precision;
  exception when invalid_text_representation or numeric_value_out_of_range then raise exception 'Site and GPS values must be valid';end;
  select * into v_site from public.client_sites where id=v_site_id and active and public.org_access_allowed(client_organization_id);
  if not found then raise exception 'Smoke source site is unavailable or access denied';end if;
  if v_complainant_site_id is not null and not exists(select 1 from public.client_sites where id=v_complainant_site_id and active and public.org_access_allowed(client_organization_id)) then raise exception 'Complainant site is unavailable or access denied';end if;
  v_complaint_source:=p_payload->>'complaint_source';v_source_type:=p_payload->>'smoke_source_type';v_severity:=p_payload->>'severity';
  if v_complaint_source not in('neighbour','council_hotline','self_report','other') then raise exception 'Unsupported complaint source';end if;
  if v_source_type not in('domestic_solid_fuel','industrial','vehicle_exhaust','agricultural','nuisance_burning','unknown') then raise exception 'Unsupported smoke source type';end if;
  if v_severity not in('low','moderate','high','critical') then raise exception 'Unsupported smoke severity';end if;
  if nullif(trim(coalesce(p_payload->>'scene_description','')),'') is null or nullif(trim(coalesce(p_payload->>'complaint_address','')),'') is null or nullif(trim(coalesce(p_payload->>'source_address','')),'') is null then raise exception 'Scene, complaint address, and source address are required';end if;
  if coalesce((p_payload->>'source_confirmed')::boolean,false) is false then raise exception 'Officer must confirm the observed smoke source';end if;
  if jsonb_typeof(v_checklist)<>'array' or jsonb_array_length(v_checklist)<4 or exists(select 1 from jsonb_array_elements(v_checklist) item where item<>'true'::jsonb) then raise exception 'All Smoke health and safety confirmations are required';end if;
  if jsonb_typeof(v_photos)<>'array' or jsonb_array_length(v_photos)<1 or jsonb_array_length(v_photos)>3 then raise exception 'Between one and three Smoke evidence photos are required';end if;
  if exists(select 1 from jsonb_array_elements(v_photos) photo where coalesce(photo->>'storage_bucket','')<>'scans' or coalesce(photo->>'storage_path','') not like 'org/'||v_profile.organization_id::text||'/smoke/'||p_client_request_id::text||'/%') then raise exception 'Smoke evidence path is outside the authorized case';end if;
  if exists(select 1 from jsonb_array_elements(v_photos) photo left join storage.objects object on object.bucket_id='scans' and object.name=photo->>'storage_path' where object.id is null) then raise exception 'Smoke evidence object does not exist';end if;
  if v_lat not between -90 and 90 or v_lng not between -180 and 180 or (v_accuracy is not null and (v_accuracy<0 or v_accuracy>1000)) then raise exception 'GPS coordinates are outside the accepted range';end if;
  insert into public.smoke_assessments(organization_id,officer_user_id,officer_id,officer_name,site_id,complainant_site_id,client_request_id,complaint_source,smoke_source_type,severity,scene_description,notes,address,complaint_address,source_confirmed,checklist,photo_urls,gps_lat,gps_lng,gps_accuracy,action_taken,legal_basis,follow_up_required,status)
  values(v_profile.organization_id,v_actor,v_actor,coalesce(nullif(trim(v_profile.display_name),''),v_profile.email),v_site.id,v_complainant_site_id,p_client_request_id,v_complaint_source,v_source_type,v_severity,trim(p_payload->>'scene_description'),nullif(trim(coalesce(p_payload->>'notes','')),''),trim(p_payload->>'source_address'),trim(p_payload->>'complaint_address'),true,v_checklist,v_photos,v_lat,v_lng,v_accuracy,'no_action',null,false,'open') returning * into v_item;
  insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata) values(v_item.organization_id,v_actor,'smoke_assessment_submitted','smoke_assessments',v_item.id,jsonb_build_object('client_request_id',p_client_request_id,'site_id',v_item.site_id,'severity',v_item.severity));
  return query select v_item.id,true,v_item.assessed_at;
end;$$;

create or replace function public.manage_smoke_assessment(p_assessment_id uuid,p_expected_status text,p_action text,p_legal_basis text,p_follow_up_required boolean,p_notes text)
returns public.smoke_assessments language plpgsql security definer set search_path=public as $$
declare v_actor uuid:=auth.uid();v_item public.smoke_assessments%rowtype;v_notice text;
begin
  select * into v_item from public.smoke_assessments where id=p_assessment_id for update;
  if not found or not public.is_admin_for_org(v_item.organization_id) then raise exception 'Active Smoke Control administrator required';end if;
  if v_item.status<>p_expected_status then raise exception 'Smoke assessment changed from expected status % to %',p_expected_status,v_item.status;end if;
  if p_action not in('no_action','verbal_warning','abatement_notice','infringement_notice','prosecution_referral') then raise exception 'Unsupported Smoke Control action';end if;
  if nullif(trim(coalesce(p_notes,'')),'') is null then raise exception 'Supervisor decision notes are required';end if;
  if p_action in('abatement_notice','infringement_notice','prosecution_referral') and nullif(trim(coalesce(p_legal_basis,'')),'') is null then raise exception 'Legal basis is required for formal Smoke action';end if;
  v_notice:=case when p_action in('abatement_notice','infringement_notice') then coalesce(v_item.notice_number,'SMK-'||to_char(clock_timestamp(),'YYYYMMDD')||'-'||upper(substr(replace(v_item.id::text,'-',''),1,8))) else v_item.notice_number end;
  update public.smoke_assessments set action_taken=p_action,action=p_action,legal_basis=case when p_action='no_action' then null else nullif(trim(coalesce(p_legal_basis,'')),'') end,follow_up_required=coalesce(p_follow_up_required,false),notice_number=v_notice,status=case when coalesce(p_follow_up_required,false) then 'follow_up' else 'actioned' end,reviewed_by=v_actor,reviewed_at=clock_timestamp(),review_notes=trim(p_notes) where id=v_item.id returning * into v_item;
  insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata) values(v_item.organization_id,v_actor,'smoke_assessment_reviewed','smoke_assessments',v_item.id,jsonb_build_object('previous_status',p_expected_status,'status',v_item.status,'action',p_action,'notice_number',v_item.notice_number,'follow_up_required',v_item.follow_up_required));
  return v_item;
end;$$;

revoke insert,update,delete on table public.smoke_assessments from public,anon,authenticated;
revoke all on function public.submit_smoke_assessment(uuid,jsonb),public.manage_smoke_assessment(uuid,text,text,text,boolean,text) from public,anon;
grant execute on function public.submit_smoke_assessment(uuid,jsonb),public.manage_smoke_assessment(uuid,text,text,text,boolean,text) to authenticated,service_role;