create view "public"."crm_account_list" with (security_invoker=true) AS  SELECT o.id,
    o.name,
    o.organization_type,
    o.organization_level,
    o.parent_organization_id,
    o.active,
    o.contact_email,
    o.contact_phone,
    COALESCE(sc.site_count, 0) AS site_count,
    pc.primary_contact_name
   FROM ((public.organizations o
     LEFT JOIN LATERAL ( SELECT (count(*))::integer AS site_count
           FROM public.client_sites cs
          WHERE ((cs.client_organization_id = o.id) AND (cs.active = true))) sc ON (true))
     LEFT JOIN LATERAL ( SELECT ((cc.first_name || ' '::text) || cc.last_name) AS primary_contact_name
           FROM public.crm_contacts cc
          WHERE ((cc.organization_id = o.id) AND (cc.is_primary = true))
         LIMIT 1) pc ON (true))
  WHERE (o.organization_type = ANY (ARRAY['client'::text, 'service_provider'::text, 'branch'::text, 'contractor'::text, 'government'::text, 'private_enterprise'::text, 'owner'::text]));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."crm_account_list" to "anon", "authenticated", "postgres", "service_role";

comment on view "public"."crm_account_list" is 'CRM account list with site count and primary contact. Inherits RLS via security_invoker.';
