create view "public"."crm_account_health" with (security_invoker=true) AS  SELECT o.id AS organization_id,
    o.name AS organization_name,
    0 AS active_breaches,
    COALESCE(inv_open.cnt, 0) AS open_invoices,
    COALESCE(inv_overdue.cnt, 0) AS overdue_invoices,
    COALESCE(roster.cnt, 0) AS active_roster
   FROM (((public.organizations o
     LEFT JOIN LATERAL ( SELECT (count(*))::integer AS cnt
           FROM public.invoices i
          WHERE ((i.client_organization_id = o.id) AND (i.status = ANY (ARRAY['draft'::text, 'sent'::text])))) inv_open ON (true))
     LEFT JOIN LATERAL ( SELECT (count(*))::integer AS cnt
           FROM public.invoices i
          WHERE ((i.client_organization_id = o.id) AND (i.status = 'sent'::text) AND (i.due_date < CURRENT_DATE))) inv_overdue ON (true))
     LEFT JOIN LATERAL ( SELECT (count(*))::integer AS cnt
           FROM public.user_profiles up
          WHERE (up.organization_id = o.id)) roster ON (true))
  WHERE (o.organization_type = ANY (ARRAY['client'::text, 'service_provider'::text, 'branch'::text, 'contractor'::text, 'government'::text, 'private_enterprise'::text, 'owner'::text]));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."crm_account_health" to "anon", "authenticated", "postgres", "service_role";

comment on view "public"."crm_account_health" is 'CRM account health KPIs (invoices, roster). Inherits RLS via security_invoker.';
