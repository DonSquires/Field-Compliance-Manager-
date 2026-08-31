create function public.purge_aam_e2e_dataset(p_provider_organization_id uuid)
returns jsonb language plpgsql volatile security definer set search_path=public as $$
declare v_account_id constant uuid:='a1000000-0000-4000-8000-000000000001';v_agreement_id constant uuid:='a1000000-0000-4000-8000-000000000004';v_location_id constant uuid:='a1000000-0000-4000-8000-000000000002';v_site_id constant uuid:='a1000000-0000-4000-8000-000000000003';
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required';end if;
  if exists(select 1 from public.organizations o where o.id=v_account_id and (o.parent_organization_id is distinct from p_provider_organization_id or o.external_refs->>'dataset' is distinct from 'aam_e2e_20260831')) then raise exception 'AAM dataset identity collision';end if;
  delete from public.shifts s where s.organization_id=p_provider_organization_id and s.notes like '[AAM E2E]%';
  delete from public.roster_slots s where s.organization_id=p_provider_organization_id and s.notes like '[AAM E2E]%';
  delete from public.shift_templates t where t.organization_id=p_provider_organization_id and t.name like '[AAM E2E]%';
  delete from public.roster_work_units w where w.organization_id=p_provider_organization_id and w.name like '[AAM E2E]%';
  delete from public.crm_activation_handoff_tasks t using public.crm_activation_handoffs h where t.handoff_id=h.id and h.account_organization_id=v_account_id;
  delete from public.crm_activation_handoffs h where h.account_organization_id=v_account_id;
  delete from public.crm_onboarding_events e where e.account_organization_id=v_account_id;
  delete from public.crm_onboarding_ledgers l where l.account_organization_id=v_account_id;
  delete from public.geofence_boundary_history h where (h.entity_type='client_site' and h.entity_id=v_site_id) or (h.entity_type='location_zone' and h.entity_id in(select z.id from public.location_zones z where z.location_id=v_location_id));
  delete from public.service_agreement_locations l where l.service_agreement_id=v_agreement_id;
  delete from public.service_agreement_modules m where m.service_agreement_id=v_agreement_id;
  delete from public.crm_commercial_settings c where c.service_agreement_id=v_agreement_id;
  delete from public.crm_contacts c where c.organization_id=v_account_id;
  delete from public.location_zones z where z.location_id=v_location_id;
  delete from public.client_sites s where s.id=v_site_id;
  delete from public.locations l where l.id=v_location_id;
  delete from public.service_agreements a where a.id=v_agreement_id;
  delete from public.organizations o where o.id=v_account_id;
  return jsonb_build_object('purged',true,'dataset','aam_e2e_20260831');
end;$$;

create function public.seed_aam_e2e_dataset(p_provider_organization_id uuid,p_owner_user_id uuid,p_admin_user_id uuid,p_admin_email text,p_officer_user_ids uuid[],p_officer_emails text[])
returns jsonb language plpgsql volatile security definer set search_path=public as $$
declare
  v_account_id constant uuid:='a1000000-0000-4000-8000-000000000001';v_location_id constant uuid:='a1000000-0000-4000-8000-000000000002';v_site_id constant uuid:='a1000000-0000-4000-8000-000000000003';v_agreement_id constant uuid:='a1000000-0000-4000-8000-000000000004';v_contact_id constant uuid:='a1000000-0000-4000-8000-000000000005';v_commercial_id constant uuid:='a1000000-0000-4000-8000-000000000006';
  v_site_link_id uuid;v_static_module_id uuid;v_work_unit_id uuid;v_module text;v_zone_type text;v_zone_id uuid;v_index integer;v_shift_type text;v_start time;v_end time;
  v_operational_modules text[]:=array['access_control','biosecurity','ems','freedom_camping','noise_control','parking_enforcement','patrol','smoke_complaints','static_guarding'];
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required';end if;
  if not exists(select 1 from public.organizations o where o.id=p_provider_organization_id and o.active) then raise exception 'Active provider organization required';end if;
  if not exists(select 1 from public.user_profiles u where u.id=p_owner_user_id and u.organization_id=p_provider_organization_id and u.role in('grand_master','master','admin') and u.deactivated_at is null) then raise exception 'Active provider owner required';end if;
  if cardinality(p_officer_user_ids)<>5 or cardinality(p_officer_emails)<>5 then raise exception 'Exactly five AAM officers are required';end if;
  perform public.purge_aam_e2e_dataset(p_provider_organization_id);

  insert into public.user_profiles(id,organization_id,role,display_name,email,deactivated_at) values(p_admin_user_id,p_provider_organization_id,'admin','AAM E2E Administrator',p_admin_email,null) on conflict(id) do update set organization_id=excluded.organization_id,role=excluded.role,display_name=excluded.display_name,email=excluded.email,deactivated_at=null;
  for v_index in 1..5 loop
    insert into public.user_profiles(id,organization_id,role,display_name,email,deactivated_at) values(p_officer_user_ids[v_index],p_provider_organization_id,'officer','AAM E2E Officer '||v_index,p_officer_emails[v_index],null) on conflict(id) do update set organization_id=excluded.organization_id,role=excluded.role,display_name=excluded.display_name,email=excluded.email,deactivated_at=null;
    insert into public.staff_profiles(id,organization_id,employee_number,employment_type,start_date,user_id,work_ready,notes) values(p_officer_user_ids[v_index],p_provider_organization_id,'AAM-'||lpad(v_index::text,3,'0'),'casual',current_date,p_officer_user_ids[v_index],true,'AAM E2E retained test identity') on conflict(id) do update set organization_id=excluded.organization_id,employee_number=excluded.employee_number,user_id=excluded.user_id,work_ready=true,notes=excluded.notes;
  end loop;

  insert into public.organizations(id,name,organization_type,parent_organization_id,active,status,contact_email,billing_email,billing_address,account_notes,external_refs) values(v_account_id,'AAM End-to-End Test Account','client',p_provider_organization_id,false,'prospect','operations@aam-e2e.test','billing@aam-e2e.test','100 Test Avenue, Wellington','Controlled synthetic account. Safe to purge and reseed.',jsonb_build_object('dataset','aam_e2e_20260831'));
  insert into public.crm_contacts(id,organization_id,first_name,last_name,role_title,email,is_primary,is_emergency) values(v_contact_id,v_account_id,'Ari','AAM','Test Operations Lead','ari@aam-e2e.test',true,true);
  insert into public.locations(id,organization_id,name,address,address_match_key,suburb,postcode,notes,created_by) values(v_location_id,v_account_id,'AAM Test Operations House','100 Test Avenue, Wellington','100testavenuewellington','Te Aro','6011','Synthetic location for module, zone, and roster verification.',p_admin_user_id);
  insert into public.client_sites(id,client_organization_id,organization_id,location_id,name,address,address_match_key,site_type,risk_level,site_brief,access_instructions,hs_notes,active,site_origin,boundary,boundary_status,boundary_verification,boundary_verified_by,boundary_verified_at,external_refs) values(v_site_id,v_account_id,v_account_id,v_location_id,'AAM Test Operations Site','100 Test Avenue, Wellington','100testavenuewellington','commercial_premises','medium','Synthetic all-module operational test site.','Use the signed east service entrance. Test access code only.','Synthetic hazards: vehicle movement and wet-surface controls.',true,'contracted',st_geomfromtext('POLYGON((174.7750 -41.2920,174.7770 -41.2920,174.7770 -41.2900,174.7750 -41.2900,174.7750 -41.2920))',4326),'authoritative','verified',p_owner_user_id,clock_timestamp(),jsonb_build_object('dataset','aam_e2e_20260831'));
  insert into public.geofence_boundary_history(entity_type,entity_id,boundary,boundary_source,verification_state,verified_by,verified_at,changed_by,changed_via,change_reason,version) select 'client_site',v_site_id,s.boundary,'aam_e2e_seed','verified',p_owner_user_id,clock_timestamp(),p_owner_user_id,'backfill','AAM E2E verified test site boundary',1 from public.client_sites s where s.id=v_site_id;

  foreach v_module in array v_operational_modules loop
    v_zone_id:=(substr(md5('aam-e2e-zone-'||v_module),1,8)||'-'||substr(md5('aam-e2e-zone-'||v_module),9,4)||'-4'||substr(md5('aam-e2e-zone-'||v_module),14,3)||'-8'||substr(md5('aam-e2e-zone-'||v_module),18,3)||'-'||substr(md5('aam-e2e-zone-'||v_module),21,12))::uuid;
    v_zone_type:=case v_module when 'access_control' then 'access_control' when 'biosecurity' then 'biosecurity' when 'freedom_camping' then 'freedom_camping' when 'noise_control' then 'noise_control' when 'parking_enforcement' then 'parking' when 'patrol' then 'patrol_route' else 'general' end;
    insert into public.location_zones(id,organization_id,location_id,name,address,zone_type,module_key,rule_type,is_active,boundary,boundary_status,boundary_verification,boundary_verified_by,boundary_verified_at,center_point,metadata) values(v_zone_id,v_account_id,v_location_id,'AAM '||replace(initcap(v_module),'_',' ')||' Zone','100 Test Avenue, Wellington',v_zone_type,v_module,'restricted',true,st_multi(st_geomfromtext('POLYGON((174.7745 -41.2925,174.7775 -41.2925,174.7775 -41.2895,174.7745 -41.2895,174.7745 -41.2925))',4326)), 'authoritative','verified',p_owner_user_id,clock_timestamp(),st_geomfromtext('POINT(174.776 -41.291)',4326),jsonb_build_object('dataset','aam_e2e_20260831'));
    insert into public.geofence_boundary_history(entity_type,entity_id,boundary,boundary_source,verification_state,verified_by,verified_at,changed_by,changed_via,change_reason,version) select 'location_zone',v_zone_id,z.boundary,'aam_e2e_seed','verified',p_owner_user_id,clock_timestamp(),p_owner_user_id,'backfill','AAM E2E verified module zone',1 from public.location_zones z where z.id=v_zone_id;
  end loop;

  insert into public.service_agreements(id,provider_organization_id,client_organization_id,name,starts_on,agreement_type,invitation_status,client_portal_access_mode,client_portal_reports_enabled,enabled_modules,external_refs) select v_agreement_id,p_provider_organization_id,v_account_id,'AAM All-Module Service Agreement',current_date,'operational','accepted','full_modules',false,array_agg(mc.module_key order by mc.module_key),jsonb_build_object('dataset','aam_e2e_20260831') from public.module_catalog mc where mc.active;
  insert into public.service_agreement_modules(id,service_agreement_id,module_key,enabled,sla_minutes,allows_client_submission,allows_auto_dispatch,standalone_scan_enabled,settings) select gen_random_uuid(),v_agreement_id,mc.module_key,true,30,true,true,(mc.module_key in('freedom_camping','parking_enforcement')),jsonb_build_object('dataset','aam_e2e_20260831') from public.module_catalog mc where mc.active;
  insert into public.service_agreement_locations(id,service_agreement_id,site_id,status,created_by) values(gen_random_uuid(),v_agreement_id,v_site_id,'active',p_admin_user_id) returning id into v_site_link_id;
  insert into public.service_agreement_locations(id,service_agreement_id,zone_id,status,created_by) select gen_random_uuid(),v_agreement_id,z.id,'active',p_admin_user_id from public.location_zones z where z.location_id=v_location_id;
  insert into public.crm_commercial_settings(id,service_agreement_id,billing_cycle,payment_terms_days,currency,base_rate_per_hour,invoice_email,notes) values(v_commercial_id,v_agreement_id,'monthly',14,'NZD',85,'billing@aam-e2e.test','AAM E2E synthetic commercial readiness');
  select sam.id into v_static_module_id from public.service_agreement_modules sam where sam.service_agreement_id=v_agreement_id and sam.module_key='static_guarding';
  insert into public.roster_work_units(organization_id,name,work_unit_type,service_type,service_agreement_location_id,service_agreement_module_id,created_by) values(p_provider_organization_id,'[AAM E2E] Static Site Operations','static','static_guarding',v_site_link_id,v_static_module_id,p_admin_user_id) returning id into v_work_unit_id;

  for v_index in 1..5 loop
    v_shift_type:=(array['day','swing','night','overnight','split'])[v_index];
    v_start:=(array['08:00','14:00','20:00','22:00','07:00'])[v_index]::time;
    v_end:=(array['16:00','22:00','04:00','06:00','11:00'])[v_index]::time;
    insert into public.shift_templates(organization_id,name,description,shift_type,start_time,end_time,recurrence_type,active_days,required_staff_count,site_id,is_active,effective_from,notes,created_by) values(p_provider_organization_id,'[AAM E2E] '||initcap(v_shift_type)||' Shift','Synthetic canonical '||v_shift_type||' shift template',v_shift_type,v_start,v_end,'weekly',array[1,2,3,4,5,6,7],1,v_site_id,true,current_date,'[AAM E2E] retained test template',p_admin_user_id);
  end loop;
  return jsonb_build_object('dataset','aam_e2e_20260831','account_id',v_account_id,'agreement_id',v_agreement_id,'location_id',v_location_id,'site_id',v_site_id,'work_unit_id',v_work_unit_id,'admin_user_id',p_admin_user_id,'officer_user_ids',to_jsonb(p_officer_user_ids),'active_module_count',(select count(*) from public.module_catalog where active),'operational_zones',(select jsonb_agg(jsonb_build_object('zone_id',z.id,'module_key',z.module_key) order by z.module_key) from public.location_zones z where z.location_id=v_location_id));
end;$$;

revoke all on function public.purge_aam_e2e_dataset(uuid),public.seed_aam_e2e_dataset(uuid,uuid,uuid,text,uuid[],text[]) from public,anon,authenticated;
grant execute on function public.purge_aam_e2e_dataset(uuid),public.seed_aam_e2e_dataset(uuid,uuid,uuid,text,uuid[],text[]) to service_role;