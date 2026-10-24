-- Behavioural check for the R&M group charge-code catalog: OneFortyOne codes
-- and derived codes are seeded on R&M and Mainland only, removal means camera
-- or CCTV removal, equipment and materials are rule targets but charge codes
-- are not, and Mainland's ownership is recorded without widening access.
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
  v_ofo constant uuid := 'c48c1aaf-236b-417c-bbce-938c151662d6';
  v_ok boolean;
  v_new_org uuid;
begin
  perform pg_temp.check('R&M and Mainland carry the same charge catalog shape',
    (select bool_and(n) from (
      select count(*) filter (where code_type = 'charge_source') = 4
         and count(*) filter (where code_type = 'charge_subject') = 29
         and count(*) filter (where code_type = 'charge_issue') = 100
         and count(*) filter (where code_type = 'charge_code') = 421 as n
        from public.reference_codes
       where organization_id in (v_rm, v_mainland) and is_active
       group by organization_id) shape) and
    (select count(distinct organization_id) from public.reference_codes where code_type = 'charge_code') = 2);
  perform pg_temp.check('camera uninstall keeps the OneFortyOne number 40570',
    exists (select 1 from public.reference_codes
             where organization_id = v_rm and code_type = 'charge_code' and code = '40570'
               and external_refs->>'origin' = 'onefortyone'));
  perform pg_temp.check('pest goat cull crosswalks to the client GL 3609',
    exists (select 1 from public.reference_codes
             where organization_id = v_mainland and code_type = 'charge_code' and code = '30132'
               and external_refs->'client_gl'->>'gl_code' = '3609'));
  perform pg_temp.check('derived codes do not invent a billing basis',
    not exists (select 1 from public.reference_codes
                 where code_type = 'charge_code' and external_refs->>'origin' = 'derived'
                   and external_refs->>'billing_basis' is not null));

  perform pg_temp.check('removal means camera or CCTV removal everywhere it was untouched',
    not exists (select 1 from public.reference_codes
                 where code_type = 'work_activity' and code = 'removal'
                   and name = 'Removal' and description not ilike '%camera%'));
  perform pg_temp.check('uninstall and manufacture are work-order candidates',
    (select bool_and((external_refs->>'work_order_candidate')::boolean)
       from public.reference_codes
      where organization_id = v_rm and code_type = 'work_activity' and code in ('uninstall', 'manufacture', 'removal')));

  perform pg_temp.check('OneFortyOne has its GL accounts, legacy ones pointing at replacements',
    (select count(*) from public.reference_codes where organization_id = v_ofo and code_type = 'gl_account') >= 25 and
    (select count(*) from public.reference_codes
      where organization_id = v_ofo and code_type = 'gl_account' and external_refs ? 'replaced_by') >= 4);

  perform pg_temp.check('Mainland ownership is recorded without parentage or access',
    (select parent_organization_id is null
        and external_refs->'corporate_group'->>'parent_organization_id' = v_rm::text
        and (external_refs->'corporate_group'->>'grants_access')::boolean = false
       from public.organizations where id = v_mainland));

  perform pg_temp.check('every R&M rule resolves to an R&M catalog row of its declared type',
    (select count(*) from public.import_value_classification_rules rule
       join public.reference_codes code on code.id = rule.target_code_id
      where rule.organization_id = v_rm and rule.source_profile = 'rm_patrol_log'
        and code.organization_id = v_rm
        and ((rule.rule_code like 'species\_%' and code.code_type = 'biosecurity_species')
          or (rule.rule_code like 'activity\_%' and code.code_type = 'work_activity')
          or (rule.rule_code like 'subject\_%' and code.code_type = 'work_subject')
          or (rule.rule_code like 'equipment\_%' and code.code_type = 'equipment_type')
          or (rule.rule_code like 'material\_%' and code.code_type = 'material_type'))) =
    (select count(*) from public.import_value_classification_rules
      where organization_id = v_rm and source_profile = 'rm_patrol_log'));
  perform pg_temp.check('ammunition rules record calibre',
    (select bool_and(code.external_refs->'detail_fields' ? 'calibre')
       from public.import_value_classification_rules rule
       join public.reference_codes code on code.id = rule.target_code_id
      where rule.organization_id = v_rm and rule.rule_code like 'material\_ammunition%'));

  v_ok := false;
  begin
    insert into public.import_value_classification_rules(organization_id, source_profile, rule_code, target_code_id, conditions)
    select v_rm, 'rm_patrol_log', 'test_charge_target', id, '[{"field":"issue","operator":"non_empty"}]'::jsonb
      from public.reference_codes where organization_id = v_rm and code_type = 'charge_code' limit 1;
  exception when others then v_ok := true; end;
  perform pg_temp.check('rules cannot target charge codes (they are composed, not classified)', v_ok);

  perform pg_temp.check('the rule-scope trigger function is not callable by API roles',
    not has_function_privilege('anon', 'public.enforce_import_value_rule_catalog_scope()', 'execute')
    and not has_function_privilege('authenticated', 'public.enforce_import_value_rule_catalog_scope()', 'execute'));

  insert into public.organizations(name, organization_type) values ('Charge catalog test org', 'client') returning id into v_new_org;
  perform pg_temp.check('a new organization gets sign, uninstall, manufacture, equipment and material templates',
    (select count(*) from public.reference_codes
      where organization_id = v_new_org
        and ((code_type = 'work_subject' and code = 'sign')
          or (code_type = 'work_activity' and code in ('uninstall', 'manufacture'))
          or (code_type = 'equipment_type' and code = 'camera')
          or (code_type = 'material_type' and code = 'ammunition'))) = 5);
  perform pg_temp.check('a new organization gets no charge catalog',
    not exists (select 1 from public.reference_codes where organization_id = v_new_org and code_type like 'charge\_%'));
end $$;

rollback;
