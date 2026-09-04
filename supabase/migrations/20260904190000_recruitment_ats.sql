-- Recruitment ends by linking an accepted candidate to the existing create-user
-- identity result, then starting the established staff onboarding workflow.

CREATE TABLE IF NOT EXISTS public.recruitment_vacancies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  title text NOT NULL,
  employment_type text NOT NULL,
  location_summary text,
  status text NOT NULL DEFAULT 'draft',
  opens_on date,
  closes_on date,
  description text,
  required_skills text[] NOT NULL DEFAULT '{}',
  created_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT recruitment_vacancies_status_check CHECK (status IN ('draft','open','closed','cancelled')),
  CONSTRAINT recruitment_vacancies_employment_check CHECK (employment_type IN ('permanent','part_time','casual','contractor','volunteer')),
  CONSTRAINT recruitment_vacancies_dates_check CHECK (closes_on IS NULL OR opens_on IS NULL OR closes_on >= opens_on)
);

CREATE TABLE IF NOT EXISTS public.recruitment_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  vacancy_id uuid NOT NULL REFERENCES public.recruitment_vacancies(id) ON DELETE CASCADE,
  first_name text NOT NULL,
  last_name text NOT NULL,
  email text NOT NULL,
  phone text,
  stage text NOT NULL DEFAULT 'applied',
  status text NOT NULL DEFAULT 'active',
  source text,
  resume_storage_path text,
  notes text,
  offer_role text,
  offer_employment_type text,
  offer_start_date date,
  offer_sent_at timestamptz,
  offer_accepted_at timestamptz,
  provisioned_user_id uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  provisioned_staff_id uuid REFERENCES public.staff_profiles(id) ON DELETE SET NULL,
  client_request_id uuid NOT NULL,
  created_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT recruitment_candidates_stage_check CHECK (stage IN ('applied','screening','interview','reference_check','offer','hired','declined','withdrawn')),
  CONSTRAINT recruitment_candidates_status_check CHECK (status IN ('active','offered','hired','declined','withdrawn')),
  UNIQUE(organization_id, client_request_id)
);

CREATE TABLE IF NOT EXISTS public.recruitment_candidate_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id uuid NOT NULL REFERENCES public.recruitment_candidates(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  from_stage text,
  to_stage text NOT NULL,
  note text NOT NULL,
  actor_user_id uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_recruitment_vacancies_org_status ON public.recruitment_vacancies(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_recruitment_candidates_org_stage ON public.recruitment_candidates(organization_id, stage, status);
CREATE INDEX IF NOT EXISTS idx_recruitment_candidate_events_candidate ON public.recruitment_candidate_events(candidate_id, created_at DESC);

ALTER TABLE public.recruitment_vacancies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recruitment_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recruitment_candidate_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY recruitment_vacancies_select ON public.recruitment_vacancies FOR SELECT TO authenticated USING(public.is_admin_for_org(organization_id));
CREATE POLICY recruitment_candidates_select ON public.recruitment_candidates FOR SELECT TO authenticated USING(public.is_admin_for_org(organization_id));
CREATE POLICY recruitment_candidate_events_select ON public.recruitment_candidate_events FOR SELECT TO authenticated USING(public.is_admin_for_org(organization_id));

REVOKE ALL ON public.recruitment_vacancies, public.recruitment_candidates, public.recruitment_candidate_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.recruitment_vacancies, public.recruitment_candidates, public.recruitment_candidate_events TO authenticated;
GRANT ALL ON public.recruitment_vacancies, public.recruitment_candidates, public.recruitment_candidate_events TO service_role;

DROP TRIGGER IF EXISTS trg_recruitment_vacancies_touch ON public.recruitment_vacancies;
CREATE TRIGGER trg_recruitment_vacancies_touch BEFORE UPDATE ON public.recruitment_vacancies FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();
DROP TRIGGER IF EXISTS trg_recruitment_candidates_touch ON public.recruitment_candidates;
CREATE TRIGGER trg_recruitment_candidates_touch BEFORE UPDATE ON public.recruitment_candidates FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();

CREATE OR REPLACE FUNCTION public.manage_recruitment_vacancy(
  p_client_request_id uuid,
  p_action text,
  p_vacancy_id uuid DEFAULT NULL,
  p_title text DEFAULT NULL,
  p_employment_type text DEFAULT NULL,
  p_location_summary text DEFAULT NULL,
  p_opens_on date DEFAULT NULL,
  p_closes_on date DEFAULT NULL,
  p_description text DEFAULT NULL,
  p_required_skills text[] DEFAULT '{}'
)
RETURNS public.recruitment_vacancies
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
declare v_actor uuid := auth.uid(); v_org uuid; v_row public.recruitment_vacancies%rowtype; v_title text := nullif(trim(coalesce(p_title,'')), '');
begin
  if p_client_request_id is null then raise exception 'client_request_id is required'; end if;
  select organization_id into v_org from public.user_profiles where id=v_actor and deactivated_at is null;
  if v_org is null or not public.is_admin_for_org(v_org) then raise exception 'Active HR administrator required'; end if;
  if p_action='create' then
    if v_title is null or p_employment_type not in ('permanent','part_time','casual','contractor','volunteer') then raise exception 'Vacancy title and employment type are required'; end if;
    insert into public.recruitment_vacancies(organization_id,title,employment_type,location_summary,status,opens_on,closes_on,description,required_skills,created_by)
    values(v_org,v_title,p_employment_type,nullif(trim(coalesce(p_location_summary,'')),''),'draft',p_opens_on,p_closes_on,nullif(trim(coalesce(p_description,'')),''),coalesce(p_required_skills,'{}'),v_actor)
    returning * into v_row;
  else
    select * into v_row from public.recruitment_vacancies where id=p_vacancy_id and organization_id=v_org for update;
    if not found then raise exception 'Vacancy not found'; end if;
    if p_action='open' then update public.recruitment_vacancies set status='open',opens_on=coalesce(p_opens_on,current_date) where id=v_row.id returning * into v_row;
    elsif p_action='close' then update public.recruitment_vacancies set status='closed',closes_on=coalesce(p_closes_on,current_date) where id=v_row.id returning * into v_row;
    elsif p_action='cancel' then update public.recruitment_vacancies set status='cancelled' where id=v_row.id returning * into v_row;
    else raise exception 'Unsupported vacancy action'; end if;
  end if;
  insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata) values(v_org,v_actor,'recruitment_vacancy_managed','recruitment_vacancies',v_row.id,jsonb_build_object('action',p_action,'client_request_id',p_client_request_id));
  return v_row;
end;
$$;
REVOKE ALL ON FUNCTION public.manage_recruitment_vacancy(uuid,text,uuid,text,text,text,date,date,text,text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.manage_recruitment_vacancy(uuid,text,uuid,text,text,text,date,date,text,text[]) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.create_recruitment_candidate(
  p_client_request_id uuid, p_vacancy_id uuid, p_first_name text, p_last_name text, p_email text, p_phone text DEFAULT NULL, p_source text DEFAULT NULL, p_resume_storage_path text DEFAULT NULL, p_notes text DEFAULT NULL
)
RETURNS public.recruitment_candidates
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
declare v_actor uuid := auth.uid(); v_vacancy public.recruitment_vacancies%rowtype; v_row public.recruitment_candidates%rowtype;
begin
  if p_client_request_id is null then raise exception 'client_request_id is required'; end if;
  select * into v_vacancy from public.recruitment_vacancies where id=p_vacancy_id for update;
  if not found or not public.is_admin_for_org(v_vacancy.organization_id) then raise exception 'Open vacancy not found in your organization'; end if;
  if v_vacancy.status<>'open' then raise exception 'Candidates can only be added to an open vacancy'; end if;
  select * into v_row from public.recruitment_candidates where organization_id=v_vacancy.organization_id and client_request_id=p_client_request_id;
  if found then return v_row; end if;
  if nullif(trim(p_first_name),'') is null or nullif(trim(p_last_name),'') is null or nullif(lower(trim(p_email)),'') is null then raise exception 'Candidate name and email are required'; end if;
  insert into public.recruitment_candidates(organization_id,vacancy_id,first_name,last_name,email,phone,source,resume_storage_path,notes,client_request_id,created_by)
  values(v_vacancy.organization_id,v_vacancy.id,trim(p_first_name),trim(p_last_name),lower(trim(p_email)),nullif(trim(coalesce(p_phone,'')),''),nullif(trim(coalesce(p_source,'')),''),nullif(trim(coalesce(p_resume_storage_path,'')),''),nullif(trim(coalesce(p_notes,'')),''),p_client_request_id,v_actor) returning * into v_row;
  insert into public.recruitment_candidate_events(candidate_id,organization_id,to_stage,note,actor_user_id) values(v_row.id,v_row.organization_id,'applied','Candidate added',v_actor);
  insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata) values(v_row.organization_id,v_actor,'recruitment_candidate_created','recruitment_candidates',v_row.id,jsonb_build_object('vacancy_id',v_row.vacancy_id,'client_request_id',p_client_request_id));
  return v_row;
end;
$$;
REVOKE ALL ON FUNCTION public.create_recruitment_candidate(uuid,uuid,text,text,text,text,text,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_recruitment_candidate(uuid,uuid,text,text,text,text,text,text,text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.manage_recruitment_candidate(
  p_candidate_id uuid, p_expected_stage text, p_next_stage text, p_note text, p_offer_role text DEFAULT NULL, p_offer_employment_type text DEFAULT NULL, p_offer_start_date date DEFAULT NULL
)
RETURNS public.recruitment_candidates
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
declare v_actor uuid := auth.uid(); v_row public.recruitment_candidates%rowtype; v_note text := nullif(trim(coalesce(p_note,'')), ''); v_status text;
begin
  select * into v_row from public.recruitment_candidates where id=p_candidate_id for update;
  if not found or not public.is_admin_for_org(v_row.organization_id) then raise exception 'Candidate not found in your organization'; end if;
  if v_row.stage<>p_expected_stage then raise exception 'Candidate changed from expected stage % to %',p_expected_stage,v_row.stage; end if;
  if v_note is null then raise exception 'A stage note is required'; end if;
  if p_next_stage not in ('screening','interview','reference_check','offer','declined','withdrawn') then raise exception 'Unsupported candidate stage'; end if;
  if p_next_stage='offer' and (p_offer_role is null or p_offer_employment_type not in ('permanent','part_time','casual','contractor','volunteer') or p_offer_start_date is null) then raise exception 'Offer role, employment type, and start date are required'; end if;
  v_status:=case when p_next_stage='offer' then 'offered' when p_next_stage='declined' then 'declined' when p_next_stage='withdrawn' then 'withdrawn' else 'active' end;
  update public.recruitment_candidates set stage=p_next_stage,status=v_status,offer_role=case when p_next_stage='offer' then trim(p_offer_role) else offer_role end,offer_employment_type=case when p_next_stage='offer' then p_offer_employment_type else offer_employment_type end,offer_start_date=case when p_next_stage='offer' then p_offer_start_date else offer_start_date end,offer_sent_at=case when p_next_stage='offer' then now() else offer_sent_at end where id=v_row.id returning * into v_row;
  insert into public.recruitment_candidate_events(candidate_id,organization_id,from_stage,to_stage,note,actor_user_id) values(v_row.id,v_row.organization_id,p_expected_stage,p_next_stage,v_note,v_actor);
  insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata) values(v_row.organization_id,v_actor,'recruitment_candidate_progressed','recruitment_candidates',v_row.id,jsonb_build_object('from_stage',p_expected_stage,'to_stage',p_next_stage));
  return v_row;
end;
$$;
REVOKE ALL ON FUNCTION public.manage_recruitment_candidate(uuid,text,text,text,text,text,date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.manage_recruitment_candidate(uuid,text,text,text,text,text,date) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.convert_recruitment_candidate_to_staff(p_candidate_id uuid, p_user_id uuid, p_staff_id uuid, p_note text)
RETURNS TABLE(candidate_id uuid, onboarding_ledger_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
declare v_actor uuid := auth.uid(); v_candidate public.recruitment_candidates%rowtype; v_staff public.staff_profiles%rowtype; v_ledger public.staff_onboarding_ledgers%rowtype; v_note text := nullif(trim(coalesce(p_note,'')), '');
begin
  select * into v_candidate from public.recruitment_candidates where id=p_candidate_id for update;
  if not found or not public.is_admin_for_org(v_candidate.organization_id) then raise exception 'Candidate not found in your organization'; end if;
  if v_candidate.stage<>'offer' or v_candidate.status<>'offered' then raise exception 'Only an offered candidate can be converted'; end if;
  if v_note is null then raise exception 'A conversion note is required'; end if;
  select * into v_staff from public.staff_profiles where id=p_staff_id and user_id=p_user_id and organization_id=v_candidate.organization_id;
  if not found then raise exception 'Provisioned user and staff records must belong to the recruiting organization'; end if;
  update public.recruitment_candidates set stage='hired',status='hired',offer_accepted_at=now(),provisioned_user_id=p_user_id,provisioned_staff_id=p_staff_id where id=v_candidate.id returning * into v_candidate;
  select * into v_ledger from public.staff_onboarding_ledgers where staff_id=v_staff.id;
  if not found then
    insert into public.staff_onboarding_ledgers(organization_id,staff_id,stage_note,target_start) values(v_candidate.organization_id,v_staff.id,v_note,v_candidate.offer_start_date) returning * into v_ledger;
    insert into public.staff_onboarding_events(ledger_id,organization_id,to_stage,to_status,note,actor_user_id,version) values(v_ledger.id,v_ledger.organization_id,'identity','in_progress',v_note,v_actor,v_ledger.version);
  end if;
  insert into public.recruitment_candidate_events(candidate_id,organization_id,from_stage,to_stage,note,actor_user_id) values(v_candidate.id,v_candidate.organization_id,'offer','hired',v_note,v_actor);
  insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata) values(v_candidate.organization_id,v_actor,'recruitment_candidate_converted','recruitment_candidates',v_candidate.id,jsonb_build_object('user_id',p_user_id,'staff_id',p_staff_id,'onboarding_ledger_id',v_ledger.id));
  return query select v_candidate.id,v_ledger.id;
end;
$$;
REVOKE ALL ON FUNCTION public.convert_recruitment_candidate_to_staff(uuid,uuid,uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.convert_recruitment_candidate_to_staff(uuid,uuid,uuid,text) TO authenticated, service_role;
