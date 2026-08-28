create view "public"."v_service_agreement_readiness" AS  WITH agreement_orgs AS (
         SELECT sa.client_organization_id AS org_id,
            count(*) AS agreements,
            min(sa.starts_on) AS first_agreement_start,
            max(sa.starts_on) AS latest_agreement_start
           FROM public.service_agreements sa
          GROUP BY sa.client_organization_id
        ), site_orgs AS (
         SELECT cs.client_organization_id AS org_id,
            count(*) AS sites,
            count(*) FILTER (WHERE (cs.service_agreement_id IS NOT NULL)) AS sites_linked
           FROM public.client_sites cs
          GROUP BY cs.client_organization_id
        ), linked_orgs AS (
         SELECT sa.client_organization_id AS org_id,
            count(DISTINCT sal.id) AS agreement_locations,
            count(DISTINCT sfc.id) AS financial_configs
           FROM ((public.service_agreements sa
             LEFT JOIN public.service_agreement_locations sal ON ((sal.service_agreement_id = sa.id)))
             LEFT JOIN public.site_financial_config sfc ON ((sfc.service_agreement_id = sa.id)))
          GROUP BY sa.client_organization_id
        )
 SELECT ao.org_id AS client_org_id,
    o.name AS client_org_name,
    ao.agreements,
    COALESCE(so.sites, (0)::bigint) AS sites,
    COALESCE(so.sites_linked, (0)::bigint) AS sites_linked,
    COALESCE(lo.agreement_locations, (0)::bigint) AS agreement_locations,
    COALESCE(lo.financial_configs, (0)::bigint) AS financial_configs,
    ao.first_agreement_start,
    ao.latest_agreement_start,
        CASE
            WHEN (COALESCE(so.sites, (0)::bigint) = 0) THEN 'needs_site_onboarding'::text
            WHEN (COALESCE(so.sites_linked, (0)::bigint) = 0) THEN 'needs_site_linking'::text
            WHEN (COALESCE(lo.agreement_locations, (0)::bigint) = 0) THEN 'needs_location_linking'::text
            WHEN (COALESCE(lo.financial_configs, (0)::bigint) = 0) THEN 'needs_financial_config'::text
            ELSE 'linked'::text
        END AS readiness_status
   FROM (((agreement_orgs ao
     LEFT JOIN site_orgs so ON ((so.org_id = ao.org_id)))
     LEFT JOIN linked_orgs lo ON ((lo.org_id = ao.org_id)))
     LEFT JOIN public.organizations o ON ((o.id = ao.org_id)));

grant delete, insert, maintain, references, select, trigger, truncate, update
  on table "public"."v_service_agreement_readiness"
  to "anon", "authenticated", "postgres", "service_role";
