-- Parent reporting is derived from branch-owned operational records.
CREATE OR REPLACE FUNCTION public.get_consolidated_reporting_overview(
  p_root_organization_id uuid,
  p_from date DEFAULT (current_date - 30),
  p_to date DEFAULT current_date
)
RETURNS TABLE(
  source_organization_id uuid,
  source_organization_name text,
  breach_count integer,
  observation_count integer,
  non_compliant_observation_count integer,
  report_pack_count integer
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
begin
  if p_root_organization_id is null or not public.is_admin_for_org(p_root_organization_id) then raise exception 'Root organization administrator required'; end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then raise exception 'Reporting period must be between one day and one year'; end if;
  return query
  with scoped_organizations as (
    select organization.id, organization.name from public.organizations organization
    where organization.id = any(public.get_descendant_organizations(p_root_organization_id))
  ), breaches as (
    select breach.organization_id, count(*)::integer as breach_count from public.breach_alerts breach
    where breach.organization_id in (select id from scoped_organizations) and breach.created_at::date between p_from and p_to group by breach.organization_id
  ), observations as (
    select observation.organization_id, count(*)::integer as observation_count, count(*) filter (where observation.is_compliant = false)::integer as non_compliant_observation_count from public.observations observation
    where observation.organization_id in (select id from scoped_organizations) and observation.observed_at::date between p_from and p_to group by observation.organization_id
  ), packs as (
    select pack.organization_id, count(*)::integer as report_pack_count from public.monthly_report_packs pack
    where pack.organization_id in (select id from scoped_organizations) and pack.period_start <= p_to and pack.period_end >= p_from group by pack.organization_id
  )
  select scoped.id, scoped.name, coalesce(breaches.breach_count, 0), coalesce(observations.observation_count, 0), coalesce(observations.non_compliant_observation_count, 0), coalesce(packs.report_pack_count, 0)
  from scoped_organizations scoped left join breaches on breaches.organization_id = scoped.id left join observations on observations.organization_id = scoped.id left join packs on packs.organization_id = scoped.id order by scoped.name;
end;
$$;

REVOKE ALL ON FUNCTION public.get_consolidated_reporting_overview(uuid,date,date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_consolidated_reporting_overview(uuid,date,date) TO authenticated, service_role;