-- Financial review is append-only: each decision supersedes the prior decision
-- without rewriting calculated pay evidence or losing the review trail.
CREATE TABLE IF NOT EXISTS public.dispatch_job_pay_line_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  pay_line_id uuid NOT NULL REFERENCES public.dispatch_job_pay_lines(id) ON DELETE CASCADE,
  decision text NOT NULL CHECK (decision IN ('approved', 'rejected')),
  review_notes text,
  reviewed_by uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  reviewed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  supersedes_review_id uuid REFERENCES public.dispatch_job_pay_line_reviews(id) ON DELETE RESTRICT,
  client_request_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dispatch_pay_line_review_rejection_notes_check
    CHECK (decision <> 'rejected' OR nullif(trim(review_notes), '') IS NOT NULL),
  CONSTRAINT dispatch_pay_line_review_request_unique UNIQUE (organization_id, client_request_id)
);

CREATE INDEX IF NOT EXISTS idx_dispatch_pay_line_reviews_line
  ON public.dispatch_job_pay_line_reviews(pay_line_id, reviewed_at DESC);

ALTER TABLE public.dispatch_job_pay_line_reviews ENABLE ROW LEVEL SECURITY;

CREATE POLICY dispatch_pay_line_reviews_select
  ON public.dispatch_job_pay_line_reviews FOR SELECT TO authenticated
  USING (public.is_admin_for_org(organization_id));

REVOKE ALL ON TABLE public.dispatch_job_pay_line_reviews FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.dispatch_job_pay_line_reviews TO authenticated;
GRANT ALL ON TABLE public.dispatch_job_pay_line_reviews TO service_role;

COMMENT ON TABLE public.dispatch_job_pay_line_reviews IS 'Append-only finance decisions for calculated dispatch pay evidence. A later decision supersedes, never updates or deletes, the earlier decision.';

CREATE OR REPLACE FUNCTION public.review_dispatch_job_pay_line(
  p_client_request_id uuid,
  p_pay_line_id uuid,
  p_expected_review_id uuid,
  p_decision text,
  p_review_notes text DEFAULT NULL
)
RETURNS public.dispatch_job_pay_line_reviews
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
declare
  v_actor uuid := auth.uid();
  v_line public.dispatch_job_pay_lines%rowtype;
  v_existing public.dispatch_job_pay_line_reviews%rowtype;
  v_current_review_id uuid;
  v_review public.dispatch_job_pay_line_reviews%rowtype;
  v_notes text := nullif(trim(coalesce(p_review_notes, '')), '');
begin
  if p_client_request_id is null then
    raise exception 'client_request_id is required';
  end if;
  if p_decision not in ('approved', 'rejected') then
    raise exception 'decision must be approved or rejected';
  end if;
  if p_decision = 'rejected' and v_notes is null then
    raise exception 'review notes are required when rejecting pay evidence';
  end if;

  select * into v_existing
  from public.dispatch_job_pay_line_reviews
  where organization_id = (select organization_id from public.dispatch_job_pay_lines where id = p_pay_line_id)
    and client_request_id = p_client_request_id;
  if found then
    return v_existing;
  end if;

  select * into v_line from public.dispatch_job_pay_lines where id = p_pay_line_id for update;
  if not found then
    raise exception 'Dispatch pay line not found';
  end if;
  if not public.is_admin_for_org(v_line.organization_id) then
    raise exception 'Not authorised to review pay evidence for this organization';
  end if;

  select r.id into v_current_review_id
  from public.dispatch_job_pay_line_reviews r
  where r.pay_line_id = v_line.id
  order by r.reviewed_at desc, r.id desc
  limit 1;
  if v_current_review_id is distinct from p_expected_review_id then
    raise exception 'Pay-line review changed; reload before deciding';
  end if;

  insert into public.dispatch_job_pay_line_reviews(
    organization_id, pay_line_id, decision, review_notes, reviewed_by, supersedes_review_id, client_request_id
  ) values (
    v_line.organization_id, v_line.id, p_decision, v_notes, v_actor, v_current_review_id, p_client_request_id
  ) returning * into v_review;

  insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (
    v_line.organization_id, v_actor, 'dispatch_pay_line_reviewed', 'dispatch_job_pay_line_reviews', v_review.id,
    jsonb_build_object('pay_line_id', v_line.id, 'decision', p_decision, 'supersedes_review_id', v_current_review_id, 'review_notes', v_notes)
  );

  return v_review;
end;
$$;

REVOKE ALL ON FUNCTION public.review_dispatch_job_pay_line(uuid,uuid,uuid,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.review_dispatch_job_pay_line(uuid,uuid,uuid,text,text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.timesheet_dispatch_pay_review_blocker(p_timesheet_id uuid)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  select case
    when line.id is null then 'missing pay evidence for dispatch work'
    when line.pay_code = 'UNRESOLVED' then 'unresolved dispatch pay evidence'
    when latest.decision is null then 'unreviewed dispatch pay evidence'
    when latest.decision <> 'approved' then 'rejected dispatch pay evidence'
  end
  from public.timesheet_work_entries work
  left join public.dispatch_job_pay_lines line
    on line.organization_id = work.organization_id
   and line.source_dispatch_id = work.source_id
  left join lateral (
    select review.decision
    from public.dispatch_job_pay_line_reviews review
    where review.pay_line_id = line.id
    order by review.reviewed_at desc, review.id desc
    limit 1
  ) latest on true
  where work.timesheet_id = p_timesheet_id
    and work.source_type = 'dispatch_job'
    and (line.id is null or line.pay_code = 'UNRESOLVED' or latest.decision is distinct from 'approved')
  order by work.created_at, line.created_at nulls first
  limit 1;
$$;

REVOKE ALL ON FUNCTION public.timesheet_dispatch_pay_review_blocker(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.timesheet_dispatch_pay_review_blocker(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.review_timesheet(
  p_timesheet_id uuid,
  p_expected_status text,
  p_decision text,
  p_review_notes text DEFAULT NULL
)
RETURNS public.timesheets
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
declare
  v_actor uuid := auth.uid();
  v_sheet public.timesheets%rowtype;
  v_notes text := nullif(trim(coalesce(p_review_notes, '')), '');
  v_officer_user_id uuid;
  v_pay_blocker text;
begin
  select t.* into v_sheet from public.timesheets t where t.id = p_timesheet_id for update;
  if not found then raise exception 'Timesheet not found'; end if;
  if not public.is_admin_for_org(v_sheet.organization_id) then raise exception 'Not authorised to review this timesheet'; end if;
  if v_sheet.status <> p_expected_status then raise exception 'Timesheet changed from expected status % to %', p_expected_status, v_sheet.status; end if;
  if v_sheet.status <> 'submitted' or p_decision not in ('approved', 'rejected') then raise exception 'Unsupported timesheet decision'; end if;
  if p_decision = 'rejected' and v_notes is null then raise exception 'Review notes are required to reject a timesheet'; end if;
  if v_sheet.actual_hours is null then raise exception 'Actual hours are required before review'; end if;

  if p_decision = 'approved' then
    v_pay_blocker := public.timesheet_dispatch_pay_review_blocker(v_sheet.id);
    if v_pay_blocker is not null then
      raise exception 'Timesheet cannot be approved: %', v_pay_blocker;
    end if;
  end if;

  update public.timesheets set status = p_decision, approved_by = v_actor, approved_at = clock_timestamp(), review_notes = v_notes where id = v_sheet.id returning * into v_sheet;
  insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata) values(v_sheet.organization_id, v_actor, case when p_decision = 'approved' then 'timesheet_approved' else 'timesheet_rejected' end, 'timesheets', v_sheet.id, jsonb_build_object('staff_id', v_sheet.staff_id, 'period_start', v_sheet.period_start, 'period_end', v_sheet.period_end, 'actual_hours', v_sheet.actual_hours, 'overtime_hours', v_sheet.overtime_hours, 'review_notes', v_notes));
  select coalesce(sp.user_id, sp.id) into v_officer_user_id from public.staff_profiles sp where sp.id = v_sheet.staff_id;
  if v_officer_user_id is not null then perform public.enqueue_notification(p_organization_id => v_sheet.organization_id, p_category => 'timesheet_decision', p_title => 'Timesheet ' || v_sheet.status, p_body => coalesce(v_notes, 'Your timesheet has been ' || v_sheet.status || '.'), p_severity => 'info', p_recipient_user_id => v_officer_user_id, p_link_page => 'timesheet-decision', p_link_payload => jsonb_build_object('timesheet_id', v_sheet.id, 'status', v_sheet.status), p_dedup_key => 'timesheet_decision:' || v_sheet.id::text || ':' || v_sheet.status); end if;
  return v_sheet;
end;
$$;

REVOKE ALL ON FUNCTION public.review_timesheet(uuid,text,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.review_timesheet(uuid,text,text,text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.create_payroll_export_batch(
  p_client_request_id uuid,
  p_organization_id uuid,
  p_period_from date,
  p_period_to date,
  p_format text DEFAULT 'csv',
  p_notes text DEFAULT NULL
)
RETURNS TABLE(batch_id uuid, timesheet_count integer, total_hours numeric)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
declare
  v_actor uuid := auth.uid();
  v_provider uuid;
  v_batch public.payroll_export_batches%rowtype;
  v_count integer;
  v_hours numeric;
  v_blocked_timesheet uuid;
  v_pay_blocker text;
begin
  if p_client_request_id is null then raise exception 'client_request_id is required'; end if;
  select actor.organization_id into v_provider from public.user_profiles actor where actor.id = v_actor and actor.deactivated_at is null;
  if v_provider is null or not public.is_admin_for_org(v_provider) then raise exception 'Active payroll administrator required'; end if;
  if p_organization_id <> v_provider then raise exception 'Organization is outside your managed hierarchy'; end if;
  if p_period_to < p_period_from then raise exception 'Export period end must not precede its start'; end if;
  if p_format not in ('csv', 'json', 'ird_csv') then raise exception 'Unsupported payroll export format'; end if;

  select t.id, public.timesheet_dispatch_pay_review_blocker(t.id) into v_blocked_timesheet, v_pay_blocker
  from public.timesheets t
  where t.organization_id = v_provider and t.status = 'approved' and t.payroll_export_batch_id is null and t.period_start >= p_period_from and t.period_end <= p_period_to
    and public.timesheet_dispatch_pay_review_blocker(t.id) is not null
  order by t.period_start, t.id
  limit 1;
  if v_blocked_timesheet is not null then raise exception 'Payroll export blocked by timesheet %: %', v_blocked_timesheet, v_pay_blocker; end if;

  select count(*), coalesce(sum(coalesce(t.actual_hours, t.work_derived_hours, 0)), 0) into v_count, v_hours from public.timesheets t where t.organization_id = v_provider and t.status = 'approved' and t.payroll_export_batch_id is null and t.period_start >= p_period_from and t.period_end <= p_period_to;
  if v_count = 0 then raise exception 'No approved unexported timesheets in this period'; end if;

  insert into public.payroll_export_batches(organization_id, exported_by, period_from, period_to, format, timesheet_count, total_hours, notes) values (v_provider, v_actor, p_period_from, p_period_to, p_format, v_count, v_hours, nullif(trim(coalesce(p_notes, '')), '')) returning * into v_batch;
  update public.timesheets t set payroll_export_batch_id = v_batch.id, status = 'paid' where t.organization_id = v_provider and t.status = 'approved' and t.payroll_export_batch_id is null and t.period_start >= p_period_from and t.period_end <= p_period_to;
  insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata) values (v_provider, v_actor, 'payroll_export_batch_created', 'payroll_export_batches', v_batch.id, jsonb_build_object('period_from', p_period_from, 'period_to', p_period_to, 'timesheet_count', v_count, 'total_hours', v_hours, 'format', p_format, 'client_request_id', p_client_request_id));
  return query select v_batch.id, v_batch.timesheet_count, v_batch.total_hours;
end;
$$;

REVOKE ALL ON FUNCTION public.create_payroll_export_batch(uuid,uuid,date,date,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_payroll_export_batch(uuid,uuid,date,date,text,text) TO authenticated, service_role;
