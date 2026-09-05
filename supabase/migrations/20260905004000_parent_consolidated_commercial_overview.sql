-- Root organizations oversee branch activity through a derived read model.
-- Source records remain owned by the operating provider branch.
CREATE OR REPLACE FUNCTION public.get_consolidated_commercial_overview(
  p_root_organization_id uuid,
  p_from date DEFAULT (current_date - 30),
  p_to date DEFAULT current_date
)
RETURNS TABLE(
  source_organization_id uuid,
  source_organization_name text,
  invoice_count integer,
  open_receivables numeric,
  overdue_receivables numeric,
  invoice_total numeric,
  quote_count integer,
  accepted_agreement_count integer,
  report_pack_count integer
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
begin
  if p_root_organization_id is null or not public.is_admin_for_org(p_root_organization_id) then raise exception 'Root organization administrator required'; end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then raise exception 'Reporting period must be between one day and one year'; end if;
  return query
  with scoped_organizations as (
    select organization.id, organization.name
    from public.organizations organization
    where organization.id = any(public.get_descendant_organizations(p_root_organization_id))
  ), invoice_totals as (
    select invoice.organization_id,
      count(*)::integer as invoice_count,
      coalesce(sum(invoice.total_amount) filter (where invoice.status in ('sent', 'overdue')), 0)::numeric as open_receivables,
      coalesce(sum(invoice.total_amount) filter (where invoice.status = 'overdue'), 0)::numeric as overdue_receivables,
      coalesce(sum(invoice.total_amount) filter (where invoice.status <> 'void'), 0)::numeric as invoice_total
    from public.invoices invoice
    where invoice.organization_id in (select id from scoped_organizations)
      and invoice.invoice_date between p_from and p_to
    group by invoice.organization_id
  ), quote_totals as (
    select quote.provider_org_id, count(*)::integer as quote_count
    from public.quotes quote
    where quote.provider_org_id in (select id from scoped_organizations)
      and quote.created_at::date between p_from and p_to
    group by quote.provider_org_id
  ), agreement_totals as (
    select agreement.provider_organization_id, count(*)::integer as accepted_agreement_count
    from public.service_agreements agreement
    where agreement.provider_organization_id in (select id from scoped_organizations)
      and agreement.agreement_type = 'operational' and agreement.invitation_status = 'accepted'
    group by agreement.provider_organization_id
  ), report_totals as (
    select pack.organization_id, count(*)::integer as report_pack_count
    from public.monthly_report_packs pack
    where pack.organization_id in (select id from scoped_organizations)
      and pack.period_start <= p_to and pack.period_end >= p_from
    group by pack.organization_id
  )
  select scoped.id, scoped.name,
    coalesce(invoices.invoice_count, 0), coalesce(invoices.open_receivables, 0), coalesce(invoices.overdue_receivables, 0), coalesce(invoices.invoice_total, 0),
    coalesce(quotes.quote_count, 0), coalesce(agreements.accepted_agreement_count, 0), coalesce(reports.report_pack_count, 0)
  from scoped_organizations scoped
  left join invoice_totals invoices on invoices.organization_id = scoped.id
  left join quote_totals quotes on quotes.provider_org_id = scoped.id
  left join agreement_totals agreements on agreements.provider_organization_id = scoped.id
  left join report_totals reports on reports.organization_id = scoped.id
  order by scoped.name;
end;
$$;

REVOKE ALL ON FUNCTION public.get_consolidated_commercial_overview(uuid,date,date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_consolidated_commercial_overview(uuid,date,date) TO authenticated, service_role;