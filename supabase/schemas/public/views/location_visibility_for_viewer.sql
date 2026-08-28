create view "public"."location_visibility_for_viewer" AS  SELECT sal.id AS sal_id,
    sal.site_id,
    sal.zone_id,
    sal.service_agreement_id,
    sal.status,
    COALESCE(sal.share_contract_price, sa.default_share_contract_price) AS share_contract_price,
    COALESCE(sal.share_actual_cost, sa.default_share_actual_cost) AS share_actual_cost,
    sa.provider_organization_id,
    sa.client_organization_id
   FROM (public.service_agreement_locations sal
     JOIN public.service_agreements sa ON ((sa.id = sal.service_agreement_id)))
  WHERE (sal.status = 'active'::text);

grant delete, insert, maintain, references, select, trigger, truncate, update
  on table "public"."location_visibility_for_viewer"
  to "anon", "authenticated", "postgres", "service_role";

comment on view "public"."location_visibility_for_viewer" is 'Effective T2 finance visibility settings per active location contract. Resolves share_contract_price and share_actual_cost with agreement-level defaults as fallback. Queryable by site_id or zone_id. RLS inherits from service_agreement_locations (0261). Epic #185 E2.';
