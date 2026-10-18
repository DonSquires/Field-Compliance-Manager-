DO $profile$
DECLARE
  v_profile public.import_source_profiles%rowtype;
BEGIN
  SELECT * INTO v_profile
  FROM public.import_source_profiles
  WHERE organization_id = 'e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13'::uuid
    AND profile_code = 'rm_patrol_log'
    AND active
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active R&M patrol import profile required';
  END IF;
  IF jsonb_typeof(v_profile.column_mappings->'day_of_week') <> 'array'
    OR v_profile.target_mappings->'day_of_week' IS DISTINCT FROM
      '{"target_entity":"file_import_finance_cost_rows","target_field":"source_values.day_of_week"}'::jsonb THEN
    RAISE EXCEPTION 'Reviewed day-of-week mapping contract is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements_text(v_profile.column_mappings->'day_of_week') alias(value)
    WHERE regexp_replace(lower(btrim(alias.value)), '\s+', ' ', 'g') = 'day of week'
  ) THEN
    UPDATE public.import_source_profiles
    SET column_mappings = jsonb_set(
          column_mappings,
          '{day_of_week}',
          (column_mappings->'day_of_week') || jsonb_build_array('Day of Week'),
          false
        ),
        updated_at = clock_timestamp()
    WHERE id = v_profile.id;

    INSERT INTO public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
    VALUES (
      v_profile.organization_id,
      NULL,
      'import_source_profile_alias_added',
      'import_source_profiles',
      v_profile.id,
      jsonb_build_object(
        'profile_code', v_profile.profile_code,
        'logical_field', 'day_of_week',
        'source_alias', 'Day of Week',
        'basis', 'reviewed active patrol workbook header'
      )
    );
  END IF;
END
$profile$;
