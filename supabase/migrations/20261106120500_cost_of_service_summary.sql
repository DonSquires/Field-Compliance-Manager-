-- Cost of service from the finance and labour records that actually exist.
--
-- Root cause: the Cost of service page only read recorded patrol travel, so
-- static and callout work with no patrol distance always looked empty, and no
-- view explained why labour was not costed.
--
-- This read-only summary reports, per service agreement:
--   * costs posted to finance_service_costs for work in the window;
--   * dispatch pay lines for callouts completed in the window;
--   * worked shift hours (actual times less recorded unpaid breaks) and the
--     exact missing step: no timesheet, timesheet not approved, or approved
--     but not posted to finance;
--   * a clearly separate estimate for unposted labour at the base hourly rate,
--     using the same precedence as payroll (snapshot, timesheet override, rate
--     rule). Rates that cannot be resolved are counted, never shown as $0.
-- It returns agreement totals only: no officer names or per-officer pay.
begin;

create or replace function public.get_cost_of_service_summary(
  p_organization_id uuid, p_from date, p_to date
) returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_result jsonb;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if p_organization_id is null or public.is_admin_for_org(p_organization_id) is not true then
    raise exception 'Cost of service access required' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 then
    raise exception 'Choose a reporting window of up to 400 days';
  end if;

  with agreements as materialized (
    select a.id, a.name, coalesce(o.name, 'Client') as client_name
    from public.service_agreements a
    left join public.organizations o on o.id = a.client_organization_id
    where a.provider_organization_id = p_organization_id
  ),
  shifts_in_window as materialized (
    select s.id, coalesce(am.service_agreement_id, sal.service_agreement_id) as agreement_id,
      s.officer_user_id, s.service_type,
      (s.actual_start at time zone 'Pacific/Auckland')::date as work_date,
      case when s.actual_end > s.actual_start then
        greatest(extract(epoch from s.actual_end - s.actual_start) / 3600.0 - coalesce(ub.hours, 0), 0)
      end as hours
    from public.shifts s
    left join public.service_agreement_modules am on am.id = s.service_agreement_module_id
    left join public.service_agreement_locations sal on sal.id = s.service_agreement_location_id
    left join lateral (
      select sum(extract(epoch from b.ended_at - b.started_at)) / 3600.0 as hours
      from public.shift_breaks b
      where b.shift_id = s.id and b.organization_id = s.organization_id
        and not b.is_paid and b.ended_at is not null
    ) ub on true
    where s.organization_id = p_organization_id
      and s.actual_start is not null
      and s.superseded_by_shift_id is null
      and (s.actual_start at time zone 'Pacific/Auckland')::date between p_from and p_to
  ),
  worked as materialized (
    select w.*,
      exists (
        select 1 from public.finance_service_costs f
        where f.organization_id = p_organization_id and f.shift_id = w.id and f.cost_type = 'labour'
      ) as posted,
      t.id as timesheet_id, t.status as timesheet_status,
      coalesce((t.payroll_snapshot ->> 'hourly_rate')::numeric, t.hourly_rate_override, r.amount) as hourly_rate
    from shifts_in_window w
    left join lateral (
      select sp.id, sp.role_code from public.staff_profiles sp
      where sp.organization_id = p_organization_id
        and (sp.id = w.officer_user_id or sp.user_id = w.officer_user_id)
      order by (sp.id = w.officer_user_id) desc, sp.id
      limit 1
    ) sp on true
    left join lateral (
      select t.id, t.status, t.payroll_snapshot, t.hourly_rate_override
      from public.timesheets t
      where t.organization_id = p_organization_id
        and (t.shift_id = w.id or (
          t.shift_id is null and t.staff_id = sp.id
          and w.work_date between t.period_start and t.period_end
        ))
      order by (t.shift_id = w.id) desc nulls last, (t.status in ('approved', 'paid')) desc, t.created_at desc
      limit 1
    ) t on true
    left join lateral (
      select rr.amount from public.rate_rules rr
      where rr.organization_id = p_organization_id and rr.rule_kind = 'pay'
        and rr.rate_type = 'hourly' and rr.active and rr.amount is not null
        and (rr.role_code is null or rr.role_code = sp.role_code)
        and (rr.service_type is null or rr.service_type = w.service_type)
        and (rr.effective_from is null or rr.effective_from <= w.work_date)
        and (rr.effective_to is null or rr.effective_to >= w.work_date)
      order by (rr.role_code is not null)::integer desc, (rr.service_type is not null)::integer desc,
        rr.priority desc, rr.effective_from desc nulls last, rr.id
      limit 1
    ) r on true
  ),
  jobs as materialized (
    select j.id, coalesce(
      (select a.id from agreements a where a.id = j.service_agreement_id),
      (select min(l.service_agreement_id::text)::uuid
         from public.service_agreement_locations l
         join agreements a on a.id = l.service_agreement_id
        where j.service_agreement_id is null and l.status = 'active'
          and (l.site_id = j.client_site_id or l.zone_id = j.zone_id)
       having count(distinct l.service_agreement_id) = 1)
    ) as agreement_id,
    exists (
      select 1 from public.finance_service_costs f
      where f.organization_id = p_organization_id and f.dispatch_job_id = j.id and f.cost_type = 'labour'
    ) as posted
    from public.dispatch_jobs j
    where j.organization_id = p_organization_id and j.status = 'completed'
      and (j.completed_at at time zone 'Pacific/Auckland')::date between p_from and p_to
  ),
  job_pay as (
    select j.agreement_id, count(distinct j.id) as jobs,
      count(distinct j.id) filter (where j.posted) as posted_jobs,
      coalesce(sum(pl.line_total) filter (where pl.rate_rule_id is not null and coalesce(pl.pay_code, '') <> 'UNRESOLVED'), 0) as pay_total,
      coalesce(sum(pl.line_total) filter (where not j.posted and pl.rate_rule_id is not null and coalesce(pl.pay_code, '') <> 'UNRESOLVED'), 0) as unposted_total,
      count(pl.id) filter (where pl.rate_rule_id is null or coalesce(pl.pay_code, '') = 'UNRESOLVED') as unresolved_lines,
      count(distinct j.id) filter (where pl.id is null) as jobs_without_pay
    from jobs j
    left join public.dispatch_job_pay_lines pl
      on pl.source_dispatch_id = j.id and pl.organization_id = p_organization_id
    group by j.agreement_id
  ),
  posted as (
    select f.service_agreement_id as agreement_id, f.cost_type,
      sum(f.total_cost) as total, count(*) as entries
    from public.finance_service_costs f
    left join public.shifts s on s.id = f.shift_id
    left join public.dispatch_jobs j on j.id = f.dispatch_job_id
    left join public.finance_pl_periods p on p.id = f.pl_period_id
    where f.organization_id = p_organization_id
      and case
        when s.id is not null then
          (coalesce(s.actual_start, s.scheduled_start) at time zone 'Pacific/Auckland')::date between p_from and p_to
        when j.id is not null then
          (coalesce(j.completed_at, j.created_at) at time zone 'Pacific/Auckland')::date between p_from and p_to
        else p.period_start <= p_to and p.period_end >= p_from
      end
    group by f.service_agreement_id, f.cost_type
  ),
  labour as (
    select w.agreement_id,
      count(*) filter (where w.hours is not null) as worked_shifts,
      count(*) filter (where w.hours is null) as in_progress_shifts,
      coalesce(sum(w.hours), 0) as hours,
      count(*) filter (where w.posted) as posted_shifts,
      count(*) filter (where not w.posted and w.hours is not null and w.timesheet_id is null) as no_timesheet,
      count(*) filter (where not w.posted and w.hours is not null and w.timesheet_id is not null
        and w.timesheet_status not in ('approved', 'paid')) as timesheet_not_approved,
      count(*) filter (where not w.posted and w.hours is not null
        and w.timesheet_status in ('approved', 'paid')) as approved_not_posted,
      coalesce(sum(w.hours * w.hourly_rate) filter (where not w.posted and w.hourly_rate is not null), 0) as estimate,
      count(*) filter (where not w.posted and w.hours is not null and w.hourly_rate is not null) as estimated_shifts,
      count(*) filter (where not w.posted and w.hours is not null and w.hourly_rate is null) as rate_unresolved
    from worked w
    group by w.agreement_id
  ),
  agreement_rows as (
    select a.id, a.name, a.client_name,
      coalesce((select sum(p.total) from posted p where p.agreement_id = a.id), 0) as posted_total,
      coalesce((select jsonb_agg(jsonb_build_object('costType', p.cost_type, 'total', round(p.total, 2), 'entries', p.entries)
        order by p.total desc, p.cost_type) from posted p where p.agreement_id = a.id), '[]'::jsonb) as posted_by_type,
      l.*, jp.jobs, jp.posted_jobs, jp.pay_total, jp.unposted_total, jp.unresolved_lines, jp.jobs_without_pay
    from agreements a
    left join labour l on l.agreement_id = a.id
    left join job_pay jp on jp.agreement_id = a.id
    where l.agreement_id is not null or jp.agreement_id is not null
      or exists (select 1 from posted p where p.agreement_id = a.id)
  )
  select jsonb_build_object(
    'version', 1,
    'window', jsonb_build_object('from', p_from, 'to', p_to),
    'agreements', coalesce((select jsonb_agg(jsonb_build_object(
      'agreementId', r.id,
      'agreementName', r.name,
      'clientName', r.client_name,
      'posted', jsonb_build_object('total', round(r.posted_total, 2), 'byType', r.posted_by_type),
      'labour', jsonb_build_object(
        'workedShifts', coalesce(r.worked_shifts, 0),
        'inProgressShifts', coalesce(r.in_progress_shifts, 0),
        'hours', round(coalesce(r.hours, 0), 2),
        'postedShifts', coalesce(r.posted_shifts, 0),
        'estimateNotPosted', round(coalesce(r.estimate, 0), 2),
        'estimatedShifts', coalesce(r.estimated_shifts, 0),
        'rateUnresolvedShifts', coalesce(r.rate_unresolved, 0),
        'missingSteps', jsonb_build_object(
          'noTimesheet', coalesce(r.no_timesheet, 0),
          'timesheetNotApproved', coalesce(r.timesheet_not_approved, 0),
          'approvedNotPosted', coalesce(r.approved_not_posted, 0)
        )
      ),
      'callouts', jsonb_build_object(
        'completedJobs', coalesce(r.jobs, 0),
        'postedJobs', coalesce(r.posted_jobs, 0),
        'payLineTotal', round(coalesce(r.pay_total, 0), 2),
        'notPostedPayTotal', round(coalesce(r.unposted_total, 0), 2),
        'unresolvedPayLines', coalesce(r.unresolved_lines, 0),
        'jobsWithoutPayLines', coalesce(r.jobs_without_pay, 0)
      )
    ) order by r.client_name, r.name, r.id) from agreement_rows r), '[]'::jsonb),
    'unattributed', jsonb_build_object(
      'workedShifts', (select count(*) from worked w where w.agreement_id is null),
      'hours', (select round(coalesce(sum(w.hours), 0), 2) from worked w where w.agreement_id is null),
      'completedJobs', (select count(*) from jobs j where j.agreement_id is null)
    )
  ) into v_result;
  return v_result;
end;
$function$;

revoke all on function public.get_cost_of_service_summary(uuid, date, date) from public, anon, authenticated, service_role;
grant execute on function public.get_cost_of_service_summary(uuid, date, date) to authenticated;

comment on function public.get_cost_of_service_summary(uuid, date, date) is
  'Admin-only cost of service per agreement: posted finance costs, callout pay lines, worked hours less unpaid breaks, missing costing steps and a separate unposted labour estimate. Agreement totals only; no officer identities or per-officer pay.';

commit;
