-- Behavioural check for the pest-control vocabulary: the platform templates
-- reach every organization, R&M label rules target the right catalog rows,
-- species is an accepted rule target, and nothing else is reclassified.
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
  v_orgs integer;
  v_ok boolean;
  v_new_org uuid;
begin
  select count(*) into v_orgs from public.organizations;

  perform pg_temp.check('every organization has the pest-control activities',
    (select count(distinct organization_id) from public.reference_codes
      where code_type = 'work_activity' and code in ('rebait', 'prefeed', 'cull', 'sighting')) = v_orgs);
  perform pg_temp.check('every organization has the species catalog',
    (select count(distinct organization_id) from public.reference_codes
      where code_type = 'biosecurity_species' and code = 'possum') = v_orgs);
  perform pg_temp.check('removal is a work-order candidate, routine pest work is not',
    (select bool_and((external_refs->>'work_order_candidate')::boolean = (code = 'removal'))
       from public.reference_codes
      where organization_id = v_rm and code_type = 'work_activity'
        and code in ('removal', 'rebait', 'prefeed', 'device_reset', 'device_unset', 'cull', 'sighting')));

  perform pg_temp.check('every new R&M rule resolves to an R&M catalog row of its declared type',
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
  perform pg_temp.check('nine species rules are active for R&M',
    (select count(*) from public.import_value_classification_rules
      where organization_id = v_rm and source_profile = 'rm_patrol_log' and rule_code like 'species\_%' and active) = 9);

  v_ok := false;
  begin
    insert into public.import_value_classification_rules(organization_id, source_profile, rule_code, target_code_id, conditions)
    select v_rm, 'rm_patrol_log', 'test_pay_item_target', id, '[{"field":"issue","operator":"non_empty"}]'::jsonb
      from public.reference_codes where organization_id = v_rm and code_type = 'pay_item' limit 1;
  exception when others then v_ok := true; end;
  perform pg_temp.check('rules still cannot target pay items', v_ok);

  v_ok := false;
  begin
    insert into public.import_value_classification_rules(organization_id, source_profile, rule_code, target_code_id, conditions)
    select v_rm, 'rm_patrol_log', 'test_cross_org_species', code.id, '[{"field":"issue","operator":"non_empty"}]'::jsonb
      from public.reference_codes code
     where code.organization_id <> v_rm and code.code_type = 'biosecurity_species' limit 1;
  exception when others then v_ok := true; end;
  perform pg_temp.check('rules cannot target another organization''s species', v_ok);

  insert into public.organizations(name, organization_type) values ('Vocabulary test org', 'client') returning id into v_new_org;
  perform pg_temp.check('a new organization is seeded with species and pest activities',
    (select count(*) from public.reference_codes
      where organization_id = v_new_org
        and ((code_type = 'biosecurity_species' and code = 'other') or (code_type = 'work_activity' and code = 'rebait'))) = 2);
end $$;

rollback;
