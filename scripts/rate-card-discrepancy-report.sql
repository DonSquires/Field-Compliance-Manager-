-- Pre-migration preview only. Run with psql against an explicitly authorised
-- database and a role whose RLS visibility covers the intended branches.
-- An empty result is not proof of completeness if the caller cannot see every
-- relevant rule, organisation and agreement. Do not apply a migration until
-- the owner has reviewed and dispositioned the findings.
BEGIN TRANSACTION READ ONLY;

WITH branches AS (
  SELECT id AS organization_id FROM public.organizations
    WHERE active AND organization_type IN ('owner', 'service_provider', 'branch')
  UNION
  SELECT organization_id FROM public.rate_rules
),
card_scopes AS (
  SELECT branch.organization_id, kind.kind, NULL::uuid AS client_organization_id, true AS is_standard
  FROM branches branch CROSS JOIN (VALUES ('charge'), ('pay')) AS kind(kind)
  UNION ALL
  SELECT DISTINCT r.organization_id, 'charge', r.client_org_id, false
  FROM public.rate_rules r WHERE r.rule_kind = 'billing' AND r.client_org_id IS NOT NULL
),
planned AS (
  SELECT scope.organization_id, branch.name AS organization_name,
    scope.kind, scope.client_organization_id, scope.is_standard,
    CASE WHEN scope.is_standard THEN 'Standard'
      ELSE coalesce(client.name, '(client not visible)') END AS card_name,
    jsonb_build_array(jsonb_build_object(
      'version_number', 1,
      'status', 'approved',
      'effective_from', CASE
        WHEN count(r.id) FILTER (WHERE r.active AND r.effective_from IS NULL) > 0 THEN NULL
        ELSE min(r.effective_from) FILTER (WHERE r.active) END,
      'rules', coalesce(jsonb_agg(jsonb_build_object(
        'id', r.id, 'name', r.name, 'amount', r.amount, 'rate_type', r.rate_type,
        'service_type', r.service_type, 'job_type', r.job_type, 'module_key', r.module_key,
        'client_org_id', r.client_org_id, 'site_id', r.site_id, 'zone_id', r.zone_id,
        'staff_id', r.staff_id, 'role_code', r.role_code, 'day_category', r.day_category,
        'region_code', r.region_code, 'job_code', r.job_code, 'vehicle_type', r.vehicle_type,
        'outside_area', r.outside_area, 'distance_min_km', r.distance_min_km,
        'distance_max_km', r.distance_max_km,
        'effective_from', r.effective_from, 'effective_to', r.effective_to, 'active', r.active
      ) ORDER BY r.name, r.id) FILTER (WHERE r.id IS NOT NULL AND r.active), '[]'::jsonb)
    )) ||
    CASE WHEN count(r.id) FILTER (WHERE NOT r.active) > 0 THEN
      jsonb_build_array(jsonb_build_object(
        'version_number', 2,
        'status', 'retired',
        'effective_from', CASE
          WHEN count(r.id) FILTER (WHERE NOT r.active AND r.effective_from IS NULL) > 0 THEN NULL
          ELSE min(r.effective_from) FILTER (WHERE NOT r.active) END,
        'rules', coalesce(jsonb_agg(jsonb_build_object(
          'id', r.id, 'name', r.name, 'amount', r.amount, 'rate_type', r.rate_type,
          'service_type', r.service_type, 'job_type', r.job_type, 'module_key', r.module_key,
          'client_org_id', r.client_org_id, 'site_id', r.site_id, 'zone_id', r.zone_id,
          'staff_id', r.staff_id, 'role_code', r.role_code, 'day_category', r.day_category,
          'region_code', r.region_code, 'job_code', r.job_code, 'vehicle_type', r.vehicle_type,
          'outside_area', r.outside_area, 'distance_min_km', r.distance_min_km,
          'distance_max_km', r.distance_max_km,
          'effective_from', r.effective_from, 'effective_to', r.effective_to, 'active', r.active
        ) ORDER BY r.name, r.id) FILTER (WHERE r.id IS NOT NULL AND NOT r.active), '[]'::jsonb)
      )) ELSE '[]'::jsonb END AS versions
  FROM card_scopes scope
  LEFT JOIN public.organizations branch ON branch.id = scope.organization_id
  LEFT JOIN public.organizations client ON client.id = scope.client_organization_id
  LEFT JOIN public.rate_rules r ON r.organization_id = scope.organization_id AND
    ((scope.kind = 'pay' AND r.rule_kind = 'pay') OR
     (scope.kind = 'charge' AND r.rule_kind = 'billing'
       AND r.client_org_id IS NOT DISTINCT FROM scope.client_organization_id))
  GROUP BY scope.organization_id, branch.name, scope.kind, scope.client_organization_id,
    scope.is_standard, client.name
),
unplaced AS (
  SELECT r.id, r.organization_id, r.client_org_id, r.rule_kind,
    CASE WHEN branch.id IS NULL THEN 'missing operating organisation'
      WHEN r.rule_kind NOT IN ('billing', 'pay') THEN 'unsupported rule kind'
      WHEN r.client_org_id IS NOT NULL AND client.id IS NULL THEN 'missing client organisation'
    END AS reason
  FROM public.rate_rules r
  LEFT JOIN public.organizations branch ON branch.id = r.organization_id
  LEFT JOIN public.organizations client ON client.id = r.client_org_id
  WHERE branch.id IS NULL OR r.rule_kind NOT IN ('billing', 'pay')
    OR (r.client_org_id IS NOT NULL AND client.id IS NULL)
),
duplicates AS (
  SELECT a.id AS first_rule_id, b.id AS second_rule_id,
    a.name AS first_name, b.name AS second_name,
    a.organization_id, a.client_org_id, a.rule_kind, a.rate_type,
    a.service_type, a.job_type, a.module_key, a.site_id, a.zone_id,
    a.staff_id, a.role_code, a.day_category, a.region_code, a.job_code,
    a.vehicle_type, a.outside_area, a.distance_min_km, a.distance_max_km,
    a.amount AS first_amount, b.amount AS second_amount,
    a.priority AS first_priority, b.priority AS second_priority,
    a.effective_from AS first_from, a.effective_to AS first_to,
    b.effective_from AS second_from, b.effective_to AS second_to
  FROM public.rate_rules a
  JOIN public.rate_rules b ON a.id < b.id
    AND a.organization_id = b.organization_id AND a.rule_kind = b.rule_kind
    AND a.rate_type = b.rate_type
    AND a.client_org_id IS NOT DISTINCT FROM b.client_org_id
    AND a.service_type IS NOT DISTINCT FROM b.service_type
    AND a.job_type IS NOT DISTINCT FROM b.job_type
    AND a.module_key IS NOT DISTINCT FROM b.module_key
    AND a.site_id IS NOT DISTINCT FROM b.site_id
    AND a.zone_id IS NOT DISTINCT FROM b.zone_id
    AND a.staff_id IS NOT DISTINCT FROM b.staff_id
    AND a.role_code IS NOT DISTINCT FROM b.role_code
    AND a.day_category IS NOT DISTINCT FROM b.day_category
    AND a.region_code IS NOT DISTINCT FROM b.region_code
    AND a.job_code IS NOT DISTINCT FROM b.job_code
    AND a.vehicle_type IS NOT DISTINCT FROM b.vehicle_type
    AND a.outside_area IS NOT DISTINCT FROM b.outside_area
    AND a.distance_min_km IS NOT DISTINCT FROM b.distance_min_km
    AND a.distance_max_km IS NOT DISTINCT FROM b.distance_max_km
  WHERE a.active AND b.active
    AND coalesce(a.effective_to, 'infinity'::date) >= (now() AT TIME ZONE 'Pacific/Auckland')::date
    AND coalesce(b.effective_to, 'infinity'::date) >= (now() AT TIME ZONE 'Pacific/Auckland')::date
    AND coalesce(a.effective_from, '-infinity'::date) <= coalesce(b.effective_to, 'infinity'::date)
    AND coalesce(b.effective_from, '-infinity'::date) <= coalesce(a.effective_to, 'infinity'::date)
),
name_collisions AS (
  SELECT a.id AS first_rule_id, b.id AS second_rule_id, a.organization_id, a.rule_kind,
    a.name AS first_name, b.name AS second_name,
    jsonb_build_object('client_org_id', a.client_org_id, 'service_type', a.service_type,
      'job_type', a.job_type, 'module_key', a.module_key, 'site_id', a.site_id, 'zone_id', a.zone_id,
      'staff_id', a.staff_id, 'role_code', a.role_code, 'day_category', a.day_category,
      'region_code', a.region_code, 'job_code', a.job_code, 'vehicle_type', a.vehicle_type,
      'outside_area', a.outside_area, 'distance_min_km', a.distance_min_km,
      'distance_max_km', a.distance_max_km, 'rate_type', a.rate_type, 'amount', a.amount,
      'priority', a.priority, 'effective_from', a.effective_from, 'effective_to', a.effective_to) AS first_scope,
    jsonb_build_object('client_org_id', b.client_org_id, 'service_type', b.service_type,
      'job_type', b.job_type, 'module_key', b.module_key, 'site_id', b.site_id, 'zone_id', b.zone_id,
      'staff_id', b.staff_id, 'role_code', b.role_code, 'day_category', b.day_category,
      'region_code', b.region_code, 'job_code', b.job_code, 'vehicle_type', b.vehicle_type,
      'outside_area', b.outside_area, 'distance_min_km', b.distance_min_km,
      'distance_max_km', b.distance_max_km, 'rate_type', b.rate_type, 'amount', b.amount,
      'priority', b.priority, 'effective_from', b.effective_from, 'effective_to', b.effective_to) AS second_scope
  FROM public.rate_rules a
  JOIN public.rate_rules b ON a.id < b.id AND a.organization_id = b.organization_id
    AND a.rule_kind = b.rule_kind AND lower(btrim(a.name)) = lower(btrim(b.name))
  WHERE a.active AND b.active
    AND coalesce(a.effective_to, 'infinity'::date) >= (now() AT TIME ZONE 'Pacific/Auckland')::date
    AND coalesce(b.effective_to, 'infinity'::date) >= (now() AT TIME ZONE 'Pacific/Auckland')::date
    AND coalesce(a.effective_from, '-infinity'::date) <= coalesce(b.effective_to, 'infinity'::date)
    AND coalesce(b.effective_from, '-infinity'::date) <= coalesce(a.effective_to, 'infinity'::date)
),
legacy_competition AS (
  SELECT a.id AS first_rule_id, b.id AS second_rule_id, a.organization_id, a.rule_kind,
    a.name AS first_name, b.name AS second_name,
    a.rate_type <> b.rate_type AS requires_unspecified_rate_type,
    'Possible overlapping resolver inputs; ordering may always favor one rule and no invocation is implied.'::text AS review_note,
    jsonb_build_object('client_org_id', a.client_org_id, 'service_type', a.service_type,
      'job_type', a.job_type, 'module_key', a.module_key, 'site_id', a.site_id, 'zone_id', a.zone_id,
      'staff_id', a.staff_id, 'role_code', a.role_code, 'day_category', a.day_category,
      'region_code', a.region_code, 'job_code', a.job_code, 'vehicle_type', a.vehicle_type,
      'outside_area', a.outside_area, 'distance_min_km', a.distance_min_km,
      'distance_max_km', a.distance_max_km, 'rate_type', a.rate_type, 'amount', a.amount,
      'priority', a.priority, 'effective_from', a.effective_from, 'effective_to', a.effective_to,
      'updated_at', a.updated_at) AS first_scope,
    jsonb_build_object('client_org_id', b.client_org_id, 'service_type', b.service_type,
      'job_type', b.job_type, 'module_key', b.module_key, 'site_id', b.site_id, 'zone_id', b.zone_id,
      'staff_id', b.staff_id, 'role_code', b.role_code, 'day_category', b.day_category,
      'region_code', b.region_code, 'job_code', b.job_code, 'vehicle_type', b.vehicle_type,
      'outside_area', b.outside_area, 'distance_min_km', b.distance_min_km,
      'distance_max_km', b.distance_max_km, 'rate_type', b.rate_type, 'amount', b.amount,
      'priority', b.priority, 'effective_from', b.effective_from, 'effective_to', b.effective_to,
      'updated_at', b.updated_at) AS second_scope
  FROM public.rate_rules a
  JOIN public.rate_rules b ON a.id < b.id AND a.organization_id = b.organization_id
    AND a.rule_kind = b.rule_kind
    AND (a.client_org_id IS NULL OR b.client_org_id IS NULL OR a.client_org_id = b.client_org_id)
    AND (a.service_type IS NULL OR b.service_type IS NULL OR a.service_type = b.service_type)
    AND (a.job_type IS NULL OR b.job_type IS NULL OR a.job_type = b.job_type)
    AND (a.module_key IS NULL OR b.module_key IS NULL OR a.module_key = b.module_key)
    AND (a.site_id IS NULL OR b.site_id IS NULL OR a.site_id = b.site_id)
    AND (a.zone_id IS NULL OR b.zone_id IS NULL OR a.zone_id = b.zone_id)
    AND (a.role_code IS NULL OR b.role_code IS NULL OR a.role_code = b.role_code)
    AND (a.day_category IS NULL OR b.day_category IS NULL OR a.day_category = b.day_category)
    AND (a.distance_min_km IS NULL OR b.distance_max_km IS NULL OR a.distance_min_km <= b.distance_max_km)
    AND (b.distance_min_km IS NULL OR a.distance_max_km IS NULL OR b.distance_min_km <= a.distance_max_km)
  WHERE a.active AND b.active
    AND (a.distance_min_km IS NULL OR a.distance_max_km IS NULL OR a.distance_min_km <= a.distance_max_km)
    AND (b.distance_min_km IS NULL OR b.distance_max_km IS NULL OR b.distance_min_km <= b.distance_max_km)
    AND coalesce(a.effective_from, '-infinity'::date) <= coalesce(a.effective_to, 'infinity'::date)
    AND coalesce(b.effective_from, '-infinity'::date) <= coalesce(b.effective_to, 'infinity'::date)
    AND coalesce(a.effective_to, 'infinity'::date) >= (now() AT TIME ZONE 'Pacific/Auckland')::date
    AND coalesce(b.effective_to, 'infinity'::date) >= (now() AT TIME ZONE 'Pacific/Auckland')::date
    AND coalesce(a.effective_from, '-infinity'::date) <= coalesce(b.effective_to, 'infinity'::date)
    AND coalesce(b.effective_from, '-infinity'::date) <= coalesce(a.effective_to, 'infinity'::date)
),
invalid_live_prices AS (
  SELECT r.id, r.organization_id, r.client_org_id, r.name, r.rule_kind,
    r.rate_type, r.amount, r.service_type, r.job_type, r.module_key, r.site_id, r.zone_id,
    r.staff_id, r.role_code, r.day_category, r.region_code, r.job_code, r.vehicle_type,
    r.outside_area, r.distance_min_km, r.distance_max_km, r.priority,
    r.effective_from, r.effective_to
  FROM public.rate_rules r
  WHERE r.active
    AND coalesce(r.effective_to, 'infinity'::date) >= (now() AT TIME ZONE 'Pacific/Auckland')::date
    AND (r.amount <= 0 OR r.amount::text IN ('NaN', 'Infinity', '-Infinity'))
),
commercial_values AS (
  SELECT agreement.id AS agreement_id, agreement.name AS agreement_name,
    agreement.provider_organization_id AS organization_id, agreement.client_organization_id,
    settings.id AS commercial_settings_id, settings.currency, settings.commercial_model,
    settings.billing_cycle, agreement.starts_on AS agreement_starts_on,
    agreement.ends_on AS agreement_ends_on, reference.comparison_date,
    (coalesce(agreement.starts_on, '-infinity'::date) <= reference.comparison_date
      AND coalesce(agreement.ends_on, 'infinity'::date) >= reference.comparison_date)
      AS agreement_current_on_reference_date,
    value.commercial_field,
    value.setting_amount, value.category
  FROM public.service_agreements agreement
  JOIN public.crm_commercial_settings settings ON settings.service_agreement_id = agreement.id
  CROSS JOIN LATERAL (SELECT (now() AT TIME ZONE 'Pacific/Auckland')::date AS comparison_date) reference
  CROSS JOIN LATERAL (VALUES
    ('base_rate_per_hour', settings.base_rate_per_hour, 'base'),
    ('overtime_rate_per_hour', settings.overtime_rate_per_hour, 'overtime'),
    ('callout_rate_per_hour', settings.callout_rate_per_hour, 'callout'),
    ('travel_rate_per_km', settings.travel_rate_per_km, 'travel')
  ) value(commercial_field, setting_amount, category)
  WHERE agreement.agreement_type = 'operational' AND value.setting_amount IS NOT NULL
),
commercial_rule_review AS (
  SELECT value.*, r.id AS rule_id, r.amount AS rule_amount,
    jsonb_build_object(
      'id', r.id, 'name', r.name, 'amount', r.amount, 'rate_type', r.rate_type,
      'service_type', r.service_type, 'job_type', r.job_type, 'module_key', r.module_key,
      'client_org_id', r.client_org_id, 'site_id', r.site_id, 'zone_id', r.zone_id,
      'staff_id', r.staff_id, 'role_code', r.role_code, 'day_category', r.day_category,
      'region_code', r.region_code, 'job_code', r.job_code, 'vehicle_type', r.vehicle_type,
      'outside_area', r.outside_area, 'distance_min_km', r.distance_min_km,
      'distance_max_km', r.distance_max_km, 'priority', r.priority, 'active', r.active,
      'effective_from', r.effective_from, 'effective_to', r.effective_to
    ) AS candidate_rule,
    array_remove(ARRAY[
      CASE WHEN NOT value.agreement_current_on_reference_date THEN 'agreement_not_current' END,
      CASE WHEN NOT r.active THEN 'inactive' END,
      CASE WHEN r.effective_to < value.comparison_date THEN 'expired' END,
      CASE WHEN r.effective_from > value.comparison_date THEN 'future' END,
      CASE WHEN r.service_type IS NOT NULL OR r.job_type IS NOT NULL OR r.module_key IS NOT NULL
        OR r.site_id IS NOT NULL OR r.zone_id IS NOT NULL OR r.staff_id IS NOT NULL
        OR r.role_code IS NOT NULL OR r.day_category IS NOT NULL OR r.region_code IS NOT NULL
        OR r.job_code IS NOT NULL OR r.vehicle_type IS NOT NULL OR r.outside_area IS NOT NULL
        OR r.distance_min_km IS NOT NULL OR r.distance_max_km IS NOT NULL
        THEN 'scope_context_required' END,
      CASE WHEN value.category = 'callout' AND r.rate_type = 'callout'
        THEN 'rate_unit_requires_review' END
    ], NULL) AS exclusion_reasons
  FROM commercial_values value
  JOIN public.rate_rules r ON r.organization_id = value.organization_id
    AND r.client_org_id = value.client_organization_id
    AND r.rule_kind = 'billing'
    AND ((value.category IN ('base', 'overtime') AND r.rate_type = 'hourly')
      OR (value.category = 'callout' AND r.rate_type IN ('hourly', 'callout'))
      OR (value.category = 'travel' AND r.rate_type = 'per_km'))
),
commercial_comparisons AS (
  SELECT value.agreement_id, value.agreement_name, value.organization_id,
    value.client_organization_id, value.commercial_settings_id, value.currency,
    value.commercial_model, value.billing_cycle, value.agreement_starts_on, value.agreement_ends_on,
    value.comparison_date, value.agreement_current_on_reference_date,
    value.commercial_field, value.setting_amount,
    'Counts include current unscoped client rules with compatible units only. Zero does not prove that no client rate exists, and a unit match does not prove contractual applicability.'::text AS comparison_note,
    count(review.rule_id) FILTER (WHERE cardinality(review.exclusion_reasons) = 0) AS candidate_count,
    coalesce(bool_or(review.rule_amount IS DISTINCT FROM value.setting_amount)
      FILTER (WHERE cardinality(review.exclusion_reasons) = 0), false) AS has_different_amount,
    coalesce(jsonb_agg(review.candidate_rule ORDER BY review.rule_id)
      FILTER (WHERE cardinality(review.exclusion_reasons) = 0), '[]'::jsonb) AS candidate_rules
  FROM commercial_values value
  LEFT JOIN commercial_rule_review review
    ON review.commercial_settings_id = value.commercial_settings_id
    AND review.commercial_field = value.commercial_field
  GROUP BY value.agreement_id, value.agreement_name, value.organization_id,
    value.client_organization_id, value.commercial_settings_id, value.currency,
    value.commercial_model, value.billing_cycle, value.agreement_starts_on, value.agreement_ends_on,
    value.comparison_date, value.agreement_current_on_reference_date, value.commercial_field, value.setting_amount
),
commercial_rule_exclusions AS (
  SELECT review.agreement_id, review.agreement_name, review.organization_id,
    review.client_organization_id, review.commercial_settings_id, review.currency,
    review.commercial_model, review.billing_cycle, review.agreement_starts_on, review.agreement_ends_on,
    review.comparison_date, review.agreement_current_on_reference_date,
    review.commercial_field, review.setting_amount, review.candidate_rule, review.exclusion_reasons
  FROM commercial_rule_review review WHERE cardinality(review.exclusion_reasons) > 0
),
commercial_mapping_issues AS (
  SELECT value.agreement_id, value.agreement_name, value.organization_id,
    value.client_organization_id, value.commercial_settings_id, value.currency,
    value.commercial_model, value.billing_cycle, value.commercial_field, value.setting_amount,
    CASE value.commercial_field
      WHEN 'base_rate_per_hour' THEN 'base_rate_hourly_or_retainer'
      WHEN 'callout_rate_per_hour' THEN 'callout_non_null_job_type'
      WHEN 'overtime_rate_per_hour' THEN 'overtime_scope_unmapped'
    END AS issue_code,
    true AS owner_review_required,
    CASE value.commercial_field
      WHEN 'base_rate_per_hour' THEN
        'The existing value is used as both an hourly rate and a monthly fee or retainer fallback; its intended card mapping needs owner review.'
      WHEN 'callout_rate_per_hour' THEN
        'The place resolver uses this value for any non-null job type; rate-rule job types match exactly. Its card mapping needs owner review.'
      WHEN 'overtime_rate_per_hour' THEN
        'The legacy rate-rule resolver has no overtime predicate; an hourly-unit comparison does not establish an overtime mapping.'
    END AS review_note
  FROM commercial_values value
  WHERE value.commercial_field IN ('base_rate_per_hour', 'callout_rate_per_hour', 'overtime_rate_per_hour')
)
SELECT jsonb_build_object(
  'read_only', current_setting('transaction_read_only') = 'on',
  'visibility_note', 'Results reflect the caller''s RLS visibility. Exact stored scope, legacy resolver competition, name collisions, and commercial comparisons are distinct review candidates, not proof of applicability or an instruction to merge, map, or select a price. The legacy resolver does not filter by name, staff, region, job code, vehicle type, or outside area.',
  'planned_cards', coalesce((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.organization_id, p.kind,
    p.is_standard DESC, p.client_organization_id) FROM planned p), '[]'::jsonb),
  'unplaced_rules', coalesce((SELECT jsonb_agg(to_jsonb(u) ORDER BY u.id) FROM unplaced u), '[]'::jsonb),
  'duplicate_live_rules', coalesce((SELECT jsonb_agg(to_jsonb(d) ORDER BY d.first_rule_id, d.second_rule_id)
    FROM duplicates d), '[]'::jsonb),
  'active_name_collisions', coalesce((SELECT jsonb_agg(to_jsonb(n) ORDER BY n.first_rule_id, n.second_rule_id)
    FROM name_collisions n), '[]'::jsonb),
  'legacy_resolver_competition', coalesce((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.first_rule_id, c.second_rule_id)
    FROM legacy_competition c), '[]'::jsonb),
  'invalid_live_rule_prices', coalesce((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id)
    FROM invalid_live_prices r), '[]'::jsonb),
  'agreement_price_comparisons', coalesce((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.agreement_id, c.commercial_field)
    FROM commercial_comparisons c), '[]'::jsonb),
  'agreement_price_conflicts', coalesce((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.agreement_id, c.commercial_field)
    FROM commercial_comparisons c WHERE c.has_different_amount), '[]'::jsonb),
  'agreement_prices_without_client_rule', coalesce((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.agreement_id, c.commercial_field)
    FROM commercial_comparisons c WHERE c.agreement_current_on_reference_date AND c.candidate_count = 0), '[]'::jsonb),
  'agreement_rule_exclusions', coalesce((SELECT jsonb_agg(to_jsonb(e) ORDER BY e.agreement_id, e.commercial_field,
    e.candidate_rule->>'id') FROM commercial_rule_exclusions e), '[]'::jsonb),
  'agreement_mapping_review', coalesce((SELECT jsonb_agg(to_jsonb(i) ORDER BY i.agreement_id, i.commercial_field)
    FROM commercial_mapping_issues i), '[]'::jsonb),
  'invalid_agreement_prices', coalesce((SELECT jsonb_agg(to_jsonb(v) ORDER BY v.agreement_id, v.commercial_field)
    FROM commercial_values v WHERE v.setting_amount <= 0
      OR v.setting_amount::text IN ('NaN', 'Infinity', '-Infinity')
      OR v.currency <> 'NZD'), '[]'::jsonb)
);
ROLLBACK;
