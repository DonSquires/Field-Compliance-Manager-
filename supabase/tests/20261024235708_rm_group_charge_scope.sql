-- Behavioural check for the R&M group charge scope: Mainland sits under R&M,
-- every group member (R&M tree plus active operational clients) holds R&M's
-- catalog, outsiders hold none, and new members are seeded automatically.
begin;
set local role postgres;
set local search_path to public, extensions, pg_catalog;

create or replace function pg_temp.check(p_label text, p_ok boolean) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL [%]', p_label; end if;
  raise notice 'ok   [%]', p_label;
end $$;

do $$
declare
  v_rm constant uuid := 'e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13';
  v_mainland constant uuid := '1ccdd3fb-0b0a-478d-8441-6f14a85172aa';
  v_catalog integer;
  v_child uuid;
  v_client uuid;
  v_outsider uuid;
begin
  select count(*) into v_catalog from public.reference_codes
   where organization_id = v_rm and code_type like 'charge\_%' and external_refs->>'scheme' = 'rm_group_charge_code';

  perform pg_temp.check('R&M owns the full catalog (4 sources + 29 subjects + 100 issues + 421 codes)', v_catalog = 554);
  perform pg_temp.check('Mainland is under R&M and one level below it',
    (select m.parent_organization_id = v_rm and m.organization_level = r.organization_level + 1
       and (m.external_refs->'corporate_group'->>'grants_access')::boolean
       from public.organizations m, public.organizations r where m.id = v_mainland and r.id = v_rm));
  perform pg_temp.check('Mainland users gain no upward reach into R&M',
    not (v_rm = any(public.get_descendant_organizations(v_mainland))));
  perform pg_temp.check('every group member holds the full catalog',
    (select bool_and(n = v_catalog) from (
       select member, (select count(*) from public.reference_codes code
                        where code.organization_id = member and code.code_type like 'charge\_%') n
       from public.charge_catalog_group_members(v_rm) member) x));
  perform pg_temp.check('the group includes Mainland and R&M client organisations',
    (select count(*) from public.charge_catalog_group_members(v_rm) member) > 20
    and exists (select 1 from public.charge_catalog_group_members(v_rm) member where member = v_mainland));
  perform pg_temp.check('copies name R&M as the catalog owner',
    (select bool_and(external_refs->>'catalog_source_organization_id' = v_rm::text)
       from public.reference_codes where organization_id <> v_rm and code_type like 'charge\_%'));
  perform pg_temp.check('no organisation outside the group holds charge codes',
    not exists (select 1 from public.reference_codes code
                 where code.code_type like 'charge\_%'
                   and code.organization_id not in (select member from public.charge_catalog_group_members(v_rm) member)));
  perform pg_temp.check('OneFortyOne codes keep their numbers and basis on client copies',
    (select bool_and(copy.external_refs->>'billing_basis' is not distinct from owner.external_refs->>'billing_basis')
       from public.reference_codes copy
       join public.reference_codes owner on owner.organization_id = v_rm and owner.code_type = copy.code_type and owner.code = copy.code
      where copy.organization_id <> v_rm and copy.code_type = 'charge_code'));

  insert into public.organizations(name, organization_type, parent_organization_id)
  values ('Group charge test child', 'client', v_rm) returning id into v_child;
  perform pg_temp.check('a new R&M child organisation receives the catalog',
    (select count(*) from public.reference_codes where organization_id = v_child and code_type like 'charge\_%') = v_catalog);

  insert into public.organizations(name, organization_type) values ('Group charge test client', 'private_enterprise') returning id into v_client;
  perform pg_temp.check('an own-rooted organisation starts without the catalog',
    not exists (select 1 from public.reference_codes where organization_id = v_client and code_type like 'charge\_%'));
  insert into public.service_agreements(provider_organization_id, client_organization_id, name, agreement_type)
  values (v_mainland, v_client, 'Group charge test agreement', 'operational');
  perform pg_temp.check('a new Mainland client receives the catalog through its agreement',
    (select count(*) from public.reference_codes where organization_id = v_client and code_type like 'charge\_%') = v_catalog);

  insert into public.organizations(name, organization_type) values ('Group charge test outsider', 'client') returning id into v_outsider;
  insert into public.service_agreements(provider_organization_id, client_organization_id, name, agreement_type, ends_on)
  values (v_rm, v_outsider, 'Ended test agreement', 'operational', current_date - 1);
  perform pg_temp.check('an ended agreement does not add a member',
    not exists (select 1 from public.reference_codes where organization_id = v_outsider and code_type like 'charge\_%'));

  perform pg_temp.check('catalog functions are not callable by API roles',
    not has_function_privilege('anon', 'public.sync_group_charge_catalog(uuid, uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.sync_group_charge_catalog(uuid, uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.refresh_group_charge_catalog(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.charge_catalog_group_members(uuid)', 'execute'));
end $$;

rollback;
