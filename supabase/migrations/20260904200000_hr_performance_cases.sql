-- Private HR lifecycle records. These are intentionally separate from incidents:
-- field incidents require a place anchor and may be visible through service
-- agreements, while employee performance and cases are employer-only records.

CREATE TABLE IF NOT EXISTS public.performance_review_cycles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  due_date date NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  created_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT performance_review_cycles_status_check CHECK (status IN ('draft','open','closed','cancelled')),
  CONSTRAINT performance_review_cycles_period_check CHECK (period_end >= period_start AND due_date >= period_end)
);

CREATE TABLE IF NOT EXISTS public.performance_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  cycle_id uuid NOT NULL REFERENCES public.performance_review_cycles(id) ON DELETE CASCADE,
  staff_id uuid NOT NULL REFERENCES public.staff_profiles(id) ON DELETE CASCADE,
  reviewer_user_id uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'pending',
  rating smallint,
  strengths text,
  development_goals text,
  employee_comments text,
  completed_at timestamptz,
  client_request_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT performance_reviews_status_check CHECK (status IN ('pending','in_progress','completed','cancelled')),
  CONSTRAINT performance_reviews_rating_check CHECK (rating IS NULL OR rating BETWEEN 1 AND 5),
  UNIQUE(cycle_id, staff_id),
  UNIQUE(organization_id, client_request_id)
);

CREATE TABLE IF NOT EXISTS public.hr_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  staff_id uuid NOT NULL REFERENCES public.staff_profiles(id) ON DELETE RESTRICT,
  case_type text NOT NULL,
  severity text NOT NULL DEFAULT 'standard',
  status text NOT NULL DEFAULT 'open',
  subject text NOT NULL,
  summary text NOT NULL,
  opened_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  assigned_to uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  opened_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  client_request_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hr_cases_type_check CHECK (case_type IN ('disciplinary','grievance','wellbeing','conduct','other')),
  CONSTRAINT hr_cases_severity_check CHECK (severity IN ('low','standard','high','critical')),
  CONSTRAINT hr_cases_status_check CHECK (status IN ('open','in_review','resolved','withdrawn')),
  UNIQUE(organization_id, client_request_id)
);

CREATE TABLE IF NOT EXISTS public.hr_case_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES public.hr_cases(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  note text NOT NULL,
  actor_user_id uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hr_case_events_type_check CHECK (event_type IN ('opened','note','status_changed','resolution'))
);

CREATE INDEX IF NOT EXISTS idx_performance_cycles_org_status ON public.performance_review_cycles(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_performance_reviews_org_status ON public.performance_reviews(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_hr_cases_org_status ON public.hr_cases(organization_id, status, severity);
CREATE INDEX IF NOT EXISTS idx_hr_case_events_case ON public.hr_case_events(case_id, created_at DESC);

ALTER TABLE public.performance_review_cycles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.performance_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hr_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hr_case_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY performance_cycles_admin_select ON public.performance_review_cycles FOR SELECT TO authenticated USING(public.is_admin_for_org(organization_id));
CREATE POLICY performance_reviews_select ON public.performance_reviews FOR SELECT TO authenticated USING(public.is_admin_for_org(organization_id) OR EXISTS (SELECT 1 FROM public.staff_profiles sp WHERE sp.id=staff_id AND sp.user_id=auth.uid()));
CREATE POLICY hr_cases_admin_select ON public.hr_cases FOR SELECT TO authenticated USING(public.is_admin_for_org(organization_id));
CREATE POLICY hr_case_events_admin_select ON public.hr_case_events FOR SELECT TO authenticated USING(public.is_admin_for_org(organization_id));

REVOKE ALL ON public.performance_review_cycles, public.performance_reviews, public.hr_cases, public.hr_case_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.performance_review_cycles, public.performance_reviews, public.hr_cases, public.hr_case_events TO authenticated;
GRANT ALL ON public.performance_review_cycles, public.performance_reviews, public.hr_cases, public.hr_case_events TO service_role;

CREATE TRIGGER trg_performance_cycles_touch BEFORE UPDATE ON public.performance_review_cycles FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();
CREATE TRIGGER trg_performance_reviews_touch BEFORE UPDATE ON public.performance_reviews FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();
CREATE TRIGGER trg_hr_cases_touch BEFORE UPDATE ON public.hr_cases FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();

CREATE OR REPLACE FUNCTION public.manage_performance_review_cycle(
  p_client_request_id uuid, p_action text, p_cycle_id uuid DEFAULT NULL,
  p_name text DEFAULT NULL, p_period_start date DEFAULT NULL, p_period_end date DEFAULT NULL, p_due_date date DEFAULT NULL
)
RETURNS public.performance_review_cycles
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
declare v_actor uuid:=auth.uid(); v_org uuid; v_cycle public.performance_review_cycles%rowtype; v_name text:=nullif(trim(coalesce(p_name,'')), '');
begin
  if p_client_request_id is null then raise exception 'client_request_id is required'; end if;
  select organization_id into v_org from public.user_profiles where id=v_actor and deactivated_at is null;
  if v_org is null or not public.is_admin_for_org(v_org) then raise exception 'Active HR administrator required'; end if;
  if p_action='create' then
    if v_name is null or p_period_start is null or p_period_end is null or p_due_date is null then raise exception 'Cycle name and dates are required'; end if;
    if p_period_end<p_period_start or p_due_date<p_period_end then raise exception 'Review cycle dates are invalid'; end if;
    insert into public.performance_review_cycles(organization_id,name,period_start,period_end,due_date,created_by) values(v_org,v_name,p_period_start,p_period_end,p_due_date,v_actor) returning * into v_cycle;
  else
    select * into v_cycle from public.performance_review_cycles where id=p_cycle_id and organization_id=v_org for update;
    if not found then raise exception 'Review cycle not found'; end if;
    if p_action='open' then update public.performance_review_cycles set status='open' where id=v_cycle.id and status='draft' returning * into v_cycle;
    elsif p_action='close' then update public.performance_review_cycles set status='closed' where id=v_cycle.id and status='open' returning * into v_cycle;
    else raise exception 'Unsupported review cycle action'; end if;
    if not found then raise exception 'Review cycle cannot transition from its current status'; end if;
  end if;
  insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata) values(v_org,v_actor,'performance_review_cycle_managed','performance_review_cycles',v_cycle.id,jsonb_build_object('action',p_action,'client_request_id',p_client_request_id));
  return v_cycle;
end;
$$;
REVOKE ALL ON FUNCTION public.manage_performance_review_cycle(uuid,text,uuid,text,date,date,date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.manage_performance_review_cycle(uuid,text,uuid,text,date,date,date) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.create_performance_review(p_client_request_id uuid, p_cycle_id uuid, p_staff_id uuid, p_reviewer_user_id uuid)
RETURNS public.performance_reviews
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
declare v_actor uuid:=auth.uid(); v_cycle public.performance_review_cycles%rowtype; v_review public.performance_reviews%rowtype;
begin
  if p_client_request_id is null then raise exception 'client_request_id is required'; end if;
  select * into v_cycle from public.performance_review_cycles where id=p_cycle_id for update;
  if not found or not public.is_admin_for_org(v_cycle.organization_id) then raise exception 'Open review cycle not found in your organization'; end if;
  if v_cycle.status<>'open' then raise exception 'Reviews can only be created for an open cycle'; end if;
  if not exists(select 1 from public.staff_profiles sp where sp.id=p_staff_id and sp.organization_id=v_cycle.organization_id) then raise exception 'Staff member not found in this organization'; end if;
  if not exists(select 1 from public.user_profiles u where u.id=p_reviewer_user_id and u.organization_id=v_cycle.organization_id and u.deactivated_at is null) then raise exception 'Reviewer must be an active organization member'; end if;
  select * into v_review from public.performance_reviews where organization_id=v_cycle.organization_id and client_request_id=p_client_request_id;
  if found then return v_review; end if;
  insert into public.performance_reviews(organization_id,cycle_id,staff_id,reviewer_user_id,client_request_id) values(v_cycle.organization_id,p_cycle_id,p_staff_id,p_reviewer_user_id,p_client_request_id) returning * into v_review;
  insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata) values(v_cycle.organization_id,v_actor,'performance_review_created','performance_reviews',v_review.id,jsonb_build_object('cycle_id',p_cycle_id,'staff_id',p_staff_id,'reviewer_user_id',p_reviewer_user_id));
  return v_review;
end;
$$;
REVOKE ALL ON FUNCTION public.create_performance_review(uuid,uuid,uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_performance_review(uuid,uuid,uuid,uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.complete_performance_review(p_review_id uuid,p_expected_status text,p_rating smallint,p_strengths text,p_development_goals text,p_employee_comments text DEFAULT NULL)
RETURNS public.performance_reviews
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
declare v_actor uuid:=auth.uid();v_review public.performance_reviews%rowtype;
begin
  select * into v_review from public.performance_reviews where id=p_review_id for update;
  if not found then raise exception 'Performance review not found'; end if;
  if v_review.reviewer_user_id<>v_actor and not public.is_admin_for_org(v_review.organization_id) then raise exception 'Only the reviewer or HR administrator can complete this review'; end if;
  if v_review.status<>p_expected_status then raise exception 'Performance review changed from expected status % to %',p_expected_status,v_review.status; end if;
  if v_review.status not in ('pending','in_progress') then raise exception 'Review is not available for completion'; end if;
  if p_rating not between 1 and 5 then raise exception 'Rating must be from 1 to 5'; end if;
  update public.performance_reviews set status='completed',rating=p_rating,strengths=nullif(trim(coalesce(p_strengths,'')),''),development_goals=nullif(trim(coalesce(p_development_goals,'')),''),employee_comments=nullif(trim(coalesce(p_employee_comments,'')),''),completed_at=now() where id=v_review.id returning * into v_review;
  insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata) values(v_review.organization_id,v_actor,'performance_review_completed','performance_reviews',v_review.id,jsonb_build_object('rating',p_rating));
  return v_review;
end;
$$;
REVOKE ALL ON FUNCTION public.complete_performance_review(uuid,text,smallint,text,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_performance_review(uuid,text,smallint,text,text,text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.manage_hr_case(p_client_request_id uuid,p_action text,p_case_id uuid DEFAULT NULL,p_staff_id uuid DEFAULT NULL,p_case_type text DEFAULT NULL,p_severity text DEFAULT 'standard',p_subject text DEFAULT NULL,p_summary text DEFAULT NULL,p_note text DEFAULT NULL,p_assigned_to uuid DEFAULT NULL)
RETURNS public.hr_cases
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
declare v_actor uuid:=auth.uid();v_org uuid;v_case public.hr_cases%rowtype;v_note text:=nullif(trim(coalesce(p_note,'')), '');
begin
  if p_client_request_id is null then raise exception 'client_request_id is required'; end if;
  select organization_id into v_org from public.user_profiles where id=v_actor and deactivated_at is null;
  if v_org is null or not public.is_admin_for_org(v_org) then raise exception 'Active HR administrator required'; end if;
  if p_action='open' then
    if p_staff_id is null or p_case_type not in ('disciplinary','grievance','wellbeing','conduct','other') or p_severity not in ('low','standard','high','critical') or nullif(trim(coalesce(p_subject,'')),'') is null or nullif(trim(coalesce(p_summary,'')),'') is null then raise exception 'Case staff, type, severity, subject, and summary are required'; end if;
    if not exists(select 1 from public.staff_profiles sp where sp.id=p_staff_id and sp.organization_id=v_org) then raise exception 'Staff member not found in this organization'; end if;
    select * into v_case from public.hr_cases where organization_id=v_org and client_request_id=p_client_request_id;if found then return v_case;end if;
    insert into public.hr_cases(organization_id,staff_id,case_type,severity,subject,summary,opened_by,assigned_to,client_request_id) values(v_org,p_staff_id,p_case_type,p_severity,trim(p_subject),trim(p_summary),v_actor,p_assigned_to,p_client_request_id) returning * into v_case;
    insert into public.hr_case_events(case_id,organization_id,event_type,note,actor_user_id) values(v_case.id,v_org,'opened',trim(p_summary),v_actor);
  else
    select * into v_case from public.hr_cases where id=p_case_id and organization_id=v_org for update;if not found then raise exception 'HR case not found';end if;
    if v_note is null then raise exception 'A case note is required'; end if;
    if p_action='note' then insert into public.hr_case_events(case_id,organization_id,event_type,note,actor_user_id) values(v_case.id,v_org,'note',v_note,v_actor);
    elsif p_action='review' then update public.hr_cases set status='in_review',assigned_to=coalesce(p_assigned_to,assigned_to) where id=v_case.id and status='open' returning * into v_case;insert into public.hr_case_events(case_id,organization_id,event_type,note,actor_user_id) values(v_case.id,v_org,'status_changed',v_note,v_actor);
    elsif p_action='resolve' then update public.hr_cases set status='resolved',resolved_at=now(),assigned_to=coalesce(p_assigned_to,assigned_to) where id=v_case.id and status in ('open','in_review') returning * into v_case;insert into public.hr_case_events(case_id,organization_id,event_type,note,actor_user_id) values(v_case.id,v_org,'resolution',v_note,v_actor);
    elsif p_action='withdraw' then update public.hr_cases set status='withdrawn',resolved_at=now() where id=v_case.id and status in ('open','in_review') returning * into v_case;insert into public.hr_case_events(case_id,organization_id,event_type,note,actor_user_id) values(v_case.id,v_org,'status_changed',v_note,v_actor);
    else raise exception 'Unsupported HR case action';end if;
    if not found then raise exception 'HR case cannot transition from its current status'; end if;
  end if;
  insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata) values(v_org,v_actor,'hr_case_managed','hr_cases',v_case.id,jsonb_build_object('action',p_action,'case_type',v_case.case_type,'severity',v_case.severity));
  return v_case;
end;
$$;
REVOKE ALL ON FUNCTION public.manage_hr_case(uuid,text,uuid,uuid,text,text,text,text,text,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.manage_hr_case(uuid,text,uuid,uuid,text,text,text,text,text,uuid) TO authenticated, service_role;
