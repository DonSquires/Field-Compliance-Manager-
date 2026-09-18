begin;
set local role postgres;
set local search_path to public, extensions, pg_catalog;
create or replace function pg_temp.as_user(p_user uuid) returns void language plpgsql as $$ begin perform set_config('request.jwt.claims', json_build_object('sub', p_user::text, 'role', 'authenticated')::text, true); perform set_config('request.jwt.claim.sub', p_user::text, true); perform set_config('request.jwt.claim.role', 'authenticated', true); set local role authenticated; end $$;
create or replace function pg_temp.check(p_label text, p_ok boolean) returns void language plpgsql as $$ begin if not coalesce(p_ok, false) then raise exception 'FAIL [%]', p_label; end if; raise notice 'ok   [%]', p_label; end $$;
do $$
declare
  v_org uuid := gen_random_uuid(); v_other uuid := gen_random_uuid(); v_admin uuid := gen_random_uuid(); v_officer uuid := gen_random_uuid();
  v_source public.fuel_price_sources%rowtype; v_row public.fuel_price_observations%rowtype; v_ok boolean; v_err text;
begin
  insert into public.organizations (id,name,organization_type,parent_organization_id,active,status) values (v_org,'Oracle Fuel Ltd','service_provider',null,true,'active'),(v_other,'Other Fuel Ltd','service_provider',null,true,'active');
  insert into public.user_profiles (id,role,organization_id,employer_organization_id,display_name) values (v_admin,'master',v_org,v_org,'Oracle Admin'),(v_officer,'officer',v_org,v_org,'Oracle Officer');
  perform pg_temp.as_user(v_officer);
  begin perform public.manage_fuel_price_source(gen_random_uuid(),v_org,'approve',null,'Fuel Watch','https://fuel.example.test/prices','petrol',null); v_ok:=false; exception when others then v_ok:=true; v_err:=sqlerrm; end;
  perform pg_temp.check('only an administrator approves a source: '||coalesce(v_err,''),v_ok);
  perform pg_temp.as_user(v_admin);
  v_source:=public.manage_fuel_price_source('11111111-1111-4111-8111-111111111111',v_org,'approve',null,'Fuel Watch','https://fuel.example.test/prices','petrol','Review weekly');
  perform pg_temp.check('admin approved a petrol source',v_source.active and v_source.fuel_type='petrol' and v_source.approved_by=v_admin);
  v_row:=public.record_approved_fuel_price_observation('22222222-2222-4222-8222-222222222222',v_org,v_source.id,current_date,2.399,'https://fuel.example.test/prices/nelson',null,'Nelson','hash');
  perform pg_temp.check('observation carries its approved source',v_row.source_id=v_source.id and v_row.source_name='Fuel Watch' and v_row.fuel_type='petrol');
  begin perform public.record_approved_fuel_price_observation(gen_random_uuid(),v_org,v_source.id,current_date,2.499,'https://elsewhere.example.test/prices',null,null,null); v_ok:=false; exception when others then v_ok:=true; v_err:=sqlerrm; end;
  perform pg_temp.check('an observation cannot claim a URL outside the approved source: '||coalesce(v_err,''),v_ok and v_err like '%approved source URL%');
  perform pg_temp.as_user(v_officer);
  perform pg_temp.check('ordinary members can read their source but cannot add it',(select count(*) from public.fuel_price_sources where id=v_source.id)=1);
  perform pg_temp.as_user(v_admin);
  v_source:=public.manage_fuel_price_source(gen_random_uuid(),v_org,'retire',v_source.id,null,null,'petrol',null);
  begin perform public.record_approved_fuel_price_observation(gen_random_uuid(),v_org,v_source.id,current_date,2.499,'https://fuel.example.test/prices/nelson',null,null,null); v_ok:=false; exception when others then v_ok:=true; v_err:=sqlerrm; end;
  perform pg_temp.check('retired source cannot accept observations: '||coalesce(v_err,''),v_ok and v_err like '%active approved%');
  perform pg_temp.check('source approvals and observation remain audited',(select count(*) from public.audit_log where organization_id=v_org and action like 'fuel_price_source_%')=2 and (select count(*) from public.audit_log where organization_id=v_org and action='fuel_price_observation_recorded')=1);
end $$;
rollback;
