-- Staff onboarding is distinct from client onboarding_invites. It is keyed to
-- the existing user_profiles/staff_profiles identity created by create-user.
CREATE TABLE IF NOT EXISTS public.staff_onboarding_ledgers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  staff_id uuid NOT NULL UNIQUE REFERENCES public.staff_profiles(id) ON DELETE CASCADE,
  assigned_to uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  current_stage text NOT NULL DEFAULT 'identity',
  status text NOT NULL DEFAULT 'in_progress',
  target_start date,
  stage_note text,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT staff_onboarding_stage_check CHECK (current_stage IN ('identity','employment','evidence','supervision','induction','review','ready')),
  CONSTRAINT staff_onboarding_status_check CHECK (status IN ('in_progress','blocked','ready','withdrawn'))
);

CREATE TABLE IF NOT EXISTS public.staff_onboarding_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ledger_id uuid NOT NULL REFERENCES public.staff_onboarding_ledgers(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  from_stage text,
  to_stage text NOT NULL,
  from_status text,
  to_status text NOT NULL,
  note text NOT NULL,
  actor_user_id uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_staff_onboarding_org_status ON public.staff_onboarding_ledgers(organization_id, status, current_stage);
CREATE INDEX IF NOT EXISTS idx_staff_onboarding_events_ledger ON public.staff_onboarding_events(ledger_id, created_at DESC);

ALTER TABLE public.staff_onboarding_ledgers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.staff_onboarding_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY staff_onboarding_ledgers_select ON public.staff_onboarding_ledgers FOR SELECT TO authenticated USING (public.is_admin_for_org(organization_id) OR EXISTS (SELECT 1 FROM public.staff_profiles sp WHERE sp.id = staff_id AND sp.user_id = auth.uid()));
CREATE POLICY staff_onboarding_events_select ON public.staff_onboarding_events FOR SELECT TO authenticated USING (public.is_admin_for_org(organization_id) OR EXISTS (SELECT 1 FROM public.staff_profiles sp JOIN public.staff_onboarding_ledgers l ON l.staff_id = sp.id WHERE l.id = ledger_id AND sp.user_id = auth.uid()));
REVOKE ALL ON public.staff_onboarding_ledgers, public.staff_onboarding_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.staff_onboarding_ledgers, public.staff_onboarding_events TO authenticated;
GRANT ALL ON public.staff_onboarding_ledgers, public.staff_onboarding_events TO service_role;
DROP TRIGGER IF EXISTS trg_staff_onboarding_touch ON public.staff_onboarding_ledgers;
CREATE TRIGGER trg_staff_onboarding_touch BEFORE UPDATE ON public.staff_onboarding_ledgers FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();

CREATE OR REPLACE FUNCTION public.start_staff_onboarding(
  p_client_request_id uuid,
  p_staff_id uuid,
  p_assigned_to uuid DEFAULT NULL,
  p_target_start date DEFAULT NULL,
  p_note text DEFAULT NULL
)
RETURNS public.staff_onboarding_ledgers
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
declare
  v_actor uuid := auth.uid();
  v_staff public.staff_profiles%rowtype;
  v_ledger public.staff_onboarding_ledgers%rowtype;
  v_note text := nullif(trim(coalesce(p_note, '')), '');
begin
  if p_client_request_id is null then raise exception 'client_request_id is required'; end if;
  select sp.* into v_staff from public.staff_profiles sp where sp.id = p_staff_id for update;
  if not found then raise exception 'Staff profile not found'; end if;
  if not public.is_admin_for_org(v_staff.organization_id) then raise exception 'Active HR administrator required'; end if;
  if p_assigned_to is not null and not exists (
    select 1 from public.user_profiles u where u.id = p_assigned_to and u.organization_id = v_staff.organization_id and u.deactivated_at is null
  ) then raise exception 'Onboarding owner must be an active member of this organization'; end if;
  select l.* into v_ledger from public.staff_onboarding_ledgers l where l.staff_id = v_staff.id;
  if found then return v_ledger; end if;
  insert into public.staff_onboarding_ledgers(organization_id, staff_id, assigned_to, target_start, stage_note)
  values (v_staff.organization_id, v_staff.id, p_assigned_to, p_target_start, coalesce(v_note, 'Staff onboarding started'))
  returning * into v_ledger;
  insert into public.staff_onboarding_events(ledger_id, organization_id, to_stage, to_status, note, actor_user_id, version)
  values (v_ledger.id, v_ledger.organization_id, v_ledger.current_stage, v_ledger.status, coalesce(v_note, 'Staff onboarding started'), v_actor, v_ledger.version);
  insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (v_ledger.organization_id, v_actor, 'staff_onboarding_started', 'staff_onboarding_ledgers', v_ledger.id,
    jsonb_build_object('staff_id', v_staff.id, 'assigned_to', p_assigned_to, 'target_start', p_target_start, 'client_request_id', p_client_request_id));
  return v_ledger;
end;
$$;

REVOKE ALL ON FUNCTION public.start_staff_onboarding(uuid,uuid,uuid,date,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.start_staff_onboarding(uuid,uuid,uuid,date,text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_staff_onboarding_readiness(p_organization_id uuid)
RETURNS TABLE(
  ledger_id uuid, staff_id uuid, user_id uuid, display_name text, current_stage text, status text,
  version integer, target_start date, identity_status text, employment_status text,
  evidence_status text, supervision_status text, induction_status text, work_status text,
  blockers text[], next_action text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
begin
  if not public.is_admin_for_org(p_organization_id) then raise exception 'Not authorised to assess staff onboarding'; end if;
  return query
  select l.id, sp.id, sp.user_id, coalesce(up.display_name, up.email, 'Unnamed staff'), l.current_stage, l.status, l.version, l.target_start,
    case when up.id is not null and up.deactivated_at is null and up.email is not null and up.display_name is not null then 'complete' else 'blocked' end,
    case when sp.start_date is not null and (sp.end_date is null or sp.end_date >= current_date) then 'complete' else 'blocked' end,
    case when exists(select 1 from public.staff_credentials c where c.staff_id=sp.id and c.verified and (c.expiry_date is null or c.expiry_date>=current_date))
      and exists(select 1 from public.staff_documents d where d.staff_id=sp.id)
      and exists(select 1 from public.staff_skills sk where sk.staff_id=sp.id) then 'complete' else 'blocked' end,
    case when exists(select 1 from public.staff_reporting sr where sr.user_id=coalesce(sp.user_id,sp.id) and sr.scope_org_id=p_organization_id and sr.relationship_type='line_manager' and sr.effective_to is null) then 'complete' else 'blocked' end,
    case when exists(select 1 from public.staff_training_records tr where tr.staff_id=sp.id and tr.training_type='induction' and coalesce(tr.passed,true) and (tr.expiry_date is null or tr.expiry_date>=current_date)) then 'complete' else 'blocked' end,
    case when sp.work_ready then 'ready' else 'blocked' end,
    array_remove(array[
      case when up.id is null or up.deactivated_at is not null or up.email is null or up.display_name is null then 'Complete active identity and invitation' end,
      case when sp.start_date is null or (sp.end_date is not null and sp.end_date<current_date) then 'Set a current employment start date' end,
      case when not exists(select 1 from public.staff_credentials c where c.staff_id=sp.id and c.verified and (c.expiry_date is null or c.expiry_date>=current_date)) then 'Verify a current credential' end,
      case when not exists(select 1 from public.staff_documents d where d.staff_id=sp.id) then 'Upload an employment or credential document' end,
      case when not exists(select 1 from public.staff_skills sk where sk.staff_id=sp.id) then 'Record at least one staff skill' end,
      case when not exists(select 1 from public.staff_reporting sr where sr.user_id=coalesce(sp.user_id,sp.id) and sr.scope_org_id=p_organization_id and sr.relationship_type='line_manager' and sr.effective_to is null) then 'Assign a line manager' end,
      case when not exists(select 1 from public.staff_training_records tr where tr.staff_id=sp.id and tr.training_type='induction' and coalesce(tr.passed,true) and (tr.expiry_date is null or tr.expiry_date>=current_date)) then 'Record completed induction' end,
      case when not sp.work_ready then 'Complete human work-readiness review' end
    ], null)::text[],
    case when up.id is null or up.deactivated_at is not null or up.email is null or up.display_name is null then 'Complete identity'
      when sp.start_date is null then 'Set employment start date'
      when not exists(select 1 from public.staff_credentials c where c.staff_id=sp.id and c.verified and (c.expiry_date is null or c.expiry_date>=current_date)) then 'Verify credential'
      when not exists(select 1 from public.staff_documents d where d.staff_id=sp.id) then 'Upload evidence'
      when not exists(select 1 from public.staff_skills sk where sk.staff_id=sp.id) then 'Record skill'
      when not exists(select 1 from public.staff_reporting sr where sr.user_id=coalesce(sp.user_id,sp.id) and sr.scope_org_id=p_organization_id and sr.relationship_type='line_manager' and sr.effective_to is null) then 'Assign line manager'
      when not exists(select 1 from public.staff_training_records tr where tr.staff_id=sp.id and tr.training_type='induction' and coalesce(tr.passed,true) and (tr.expiry_date is null or tr.expiry_date>=current_date)) then 'Record induction'
      when not sp.work_ready then 'Review work readiness' else 'Ready' end
  from public.staff_onboarding_ledgers l
  join public.staff_profiles sp on sp.id=l.staff_id
  left join public.user_profiles up on up.id=coalesce(sp.user_id,sp.id)
  where l.organization_id=p_organization_id
  order by l.current_stage, up.display_name nulls last;
end;
$$;

REVOKE ALL ON FUNCTION public.get_staff_onboarding_readiness(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_staff_onboarding_readiness(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.manage_staff_onboarding(
  p_ledger_id uuid,
  p_expected_version integer,
  p_action text,
  p_stage text DEFAULT NULL,
  p_note text DEFAULT NULL,
  p_assigned_to uuid DEFAULT NULL,
  p_target_start date DEFAULT NULL
)
RETURNS public.staff_onboarding_ledgers
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
declare
  v_actor uuid := auth.uid(); v_ledger public.staff_onboarding_ledgers%rowtype; v_next text; v_next_status text; v_previous_stage text; v_previous_status text; v_note text:=nullif(trim(coalesce(p_note,'')),''); v_readiness record;
  v_order text[] := array['identity','employment','evidence','supervision','induction','review','ready'];
begin
  select l.* into v_ledger from public.staff_onboarding_ledgers l where l.id=p_ledger_id for update;
  if not found then raise exception 'Staff onboarding ledger not found'; end if;
  if not public.is_admin_for_org(v_ledger.organization_id) then raise exception 'Not authorised to manage staff onboarding'; end if;
  if v_ledger.version<>p_expected_version then raise exception 'Staff onboarding changed since it was opened'; end if;
  if v_note is null then raise exception 'A stage note is required'; end if;

  v_next:=coalesce(p_stage,v_ledger.current_stage);
  if p_action not in ('advance','return','assign','block','withdraw') then raise exception 'Unsupported onboarding action'; end if;
  if p_action in ('advance','return') then
    if array_position(v_order,v_next) is null then raise exception 'Unsupported onboarding stage'; end if;
    if p_action='advance' and array_position(v_order,v_next)>array_position(v_order,v_ledger.current_stage)+1 then raise exception 'Stages must advance one step at a time'; end if;
  end if;
  if p_action='advance' and v_next in ('employment','evidence','supervision','induction','review','ready') then
    select * into v_readiness from public.get_staff_onboarding_readiness(v_ledger.organization_id) r where r.ledger_id=v_ledger.id;
    if v_next='employment' and v_readiness.identity_status<>'complete' then raise exception 'Identity must be complete before employment'; end if;
    if v_next='evidence' and v_readiness.employment_status<>'complete' then raise exception 'Employment details must be complete before evidence'; end if;
    if v_next='supervision' and v_readiness.evidence_status<>'complete' then raise exception 'Credential, document, and skill evidence must be complete before supervision'; end if;
    if v_next='induction' and v_readiness.supervision_status<>'complete' then raise exception 'A line manager must be assigned before induction'; end if;
    if v_next='review' and v_readiness.induction_status<>'complete' then raise exception 'Induction must be complete before review'; end if;
    if v_next='ready' and (v_readiness.blockers is not null and array_length(v_readiness.blockers,1)>0) then raise exception 'Staff onboarding blockers remain: %', array_to_string(v_readiness.blockers,'; '); end if;
  end if;
  v_next_status:=case when p_action='block' then 'blocked' when p_action='withdraw' then 'withdrawn' when v_next='ready' then 'ready' else 'in_progress' end;

  v_previous_stage:=v_ledger.current_stage; v_previous_status:=v_ledger.status;
  update public.staff_onboarding_ledgers set current_stage=v_next, status=v_next_status, stage_note=v_note, assigned_to=coalesce(p_assigned_to,assigned_to), target_start=coalesce(p_target_start,target_start), version=version+1 where id=v_ledger.id returning * into v_ledger;
  insert into public.staff_onboarding_events(ledger_id,organization_id,from_stage,to_stage,from_status,to_status,note,actor_user_id,version)
  values(v_ledger.id,v_ledger.organization_id,v_previous_stage,v_next,v_previous_status,v_next_status,v_note,v_actor,v_ledger.version);
  insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)
  values(v_ledger.organization_id,v_actor,'staff_onboarding_stage_changed','staff_onboarding_ledgers',v_ledger.id,jsonb_build_object('stage',v_next,'status',v_next_status,'note',v_note,'version',v_ledger.version));
  return v_ledger;
end;
$$;

REVOKE ALL ON FUNCTION public.manage_staff_onboarding(uuid,integer,text,text,text,uuid,date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.manage_staff_onboarding(uuid,integer,text,text,text,uuid,date) TO authenticated, service_role;
