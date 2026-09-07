-- Investigation workspace: a multi-site, court-facing source of truth that links
-- reports, incidents, observations, evidence, and investigation-origin dispatch.

CREATE TABLE IF NOT EXISTS public.investigations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  investigation_reference text NOT NULL,
  title text NOT NULL,
  investigation_type text NOT NULL DEFAULT 'other',
  status text NOT NULL DEFAULT 'open',
  priority text NOT NULL DEFAULT 'medium',
  summary text,
  lead_user_id uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  resolution_notes text,
  legal_hold boolean NOT NULL DEFAULT false,
  opened_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  resolved_at timestamptz,
  closed_at timestamptz,
  created_by uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT investigations_status_check CHECK (status IN ('open','active','awaiting_evidence','awaiting_review','referred','court','resolved','closed')),
  CONSTRAINT investigations_priority_check CHECK (priority IN ('low','medium','high','critical')),
  CONSTRAINT investigations_type_check CHECK (investigation_type IN ('incident','compliance','enforcement','safety','biosecurity','noise','smoke','parking','welfare','other'))
);

CREATE UNIQUE INDEX IF NOT EXISTS investigations_org_reference_key
  ON public.investigations (organization_id, investigation_reference);

CREATE TABLE IF NOT EXISTS public.investigation_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  investigation_id uuid NOT NULL REFERENCES public.investigations(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  link_role text NOT NULL DEFAULT 'supporting',
  link_reason text NOT NULL,
  linked_by uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  linked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT investigation_links_entity_type_check CHECK (entity_type IN ('observation','field_report','incident','evidence','site','zone','person','vehicle','dispatch_job')),
  CONSTRAINT investigation_links_role_check CHECK (link_role IN ('primary','supporting','context','lead','excluded'))
);

CREATE UNIQUE INDEX IF NOT EXISTS investigation_links_unique_entity
  ON public.investigation_links (investigation_id, entity_type, entity_id);

CREATE TABLE IF NOT EXISTS public.investigation_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  investigation_id uuid NOT NULL REFERENCES public.investigations(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  event_type text NOT NULL,
  description text NOT NULL,
  source_table text,
  source_id uuid,
  created_by uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

ALTER TABLE public.officer_field_reports
  ADD COLUMN IF NOT EXISTS investigation_id uuid REFERENCES public.investigations(id) ON DELETE SET NULL;
ALTER TABLE public.incidents
  ADD COLUMN IF NOT EXISTS investigation_id uuid REFERENCES public.investigations(id) ON DELETE SET NULL;
ALTER TABLE public.dispatch_jobs
  ADD COLUMN IF NOT EXISTS investigation_id uuid REFERENCES public.investigations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS origin_type text NOT NULL DEFAULT 'standard',
  ADD COLUMN IF NOT EXISTS origin_reference_id uuid;

ALTER TABLE public.dispatch_jobs DROP CONSTRAINT IF EXISTS dispatch_jobs_origin_type_check;
ALTER TABLE public.dispatch_jobs ADD CONSTRAINT dispatch_jobs_origin_type_check CHECK (origin_type IN ('standard','investigation_follow_up'));

CREATE INDEX IF NOT EXISTS investigation_links_entity_lookup ON public.investigation_links (organization_id, entity_type, entity_id);
CREATE INDEX IF NOT EXISTS investigation_events_timeline ON public.investigation_events (investigation_id, created_at);
CREATE INDEX IF NOT EXISTS dispatch_jobs_investigation ON public.dispatch_jobs (investigation_id) WHERE investigation_id IS NOT NULL;

ALTER TABLE public.investigations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.investigation_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.investigation_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY investigations_select ON public.investigations FOR SELECT USING (public.org_access_allowed(organization_id));
CREATE POLICY investigation_links_select ON public.investigation_links FOR SELECT USING (public.org_access_allowed(organization_id));
CREATE POLICY investigation_events_select ON public.investigation_events FOR SELECT USING (public.org_access_allowed(organization_id));
REVOKE INSERT, UPDATE, DELETE ON public.investigations, public.investigation_links, public.investigation_events FROM public, anon, authenticated;

CREATE OR REPLACE FUNCTION public.create_investigation(
  p_organization_id uuid,
  p_client_request_id uuid,
  p_reference text,
  p_title text,
  p_investigation_type text DEFAULT 'other',
  p_priority text DEFAULT 'medium',
  p_summary text DEFAULT NULL,
  p_lead_user_id uuid DEFAULT NULL
) RETURNS public.investigations
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_actor uuid := auth.uid(); v_item public.investigations%rowtype;
BEGIN
  IF v_actor IS NULL OR NOT public.is_admin_for_org(p_organization_id) THEN RAISE EXCEPTION 'Active organization administrator required'; END IF;
  IF p_client_request_id IS NULL THEN RAISE EXCEPTION 'client_request_id is required'; END IF;
  IF nullif(trim(p_reference),'') IS NULL OR nullif(trim(p_title),'') IS NULL THEN RAISE EXCEPTION 'Investigation reference and title are required'; END IF;
  SELECT * INTO v_item FROM public.investigations WHERE organization_id=p_organization_id AND investigation_reference=trim(p_reference) FOR UPDATE;
  IF FOUND THEN RETURN v_item; END IF;
  INSERT INTO public.investigations (organization_id, investigation_reference, title, investigation_type, priority, summary, lead_user_id, created_by)
  VALUES (p_organization_id, trim(p_reference), trim(p_title), p_investigation_type, p_priority, nullif(trim(p_summary),''), p_lead_user_id, v_actor)
  RETURNING * INTO v_item;
  INSERT INTO public.investigation_events (investigation_id, organization_id, event_type, description, created_by)
  VALUES (v_item.id, p_organization_id, 'investigation_opened', 'Investigation opened', v_actor);
  RETURN v_item;
END;
$$;

CREATE OR REPLACE FUNCTION public.link_investigation_entity(
  p_investigation_id uuid,
  p_entity_type text,
  p_entity_id uuid,
  p_link_role text,
  p_link_reason text
) RETURNS public.investigation_links
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_actor uuid := auth.uid(); v_item public.investigations%rowtype; v_link public.investigation_links%rowtype;
BEGIN
  SELECT * INTO v_item FROM public.investigations WHERE id=p_investigation_id FOR UPDATE;
  IF NOT FOUND OR v_actor IS NULL OR NOT public.is_admin_for_org(v_item.organization_id) THEN RAISE EXCEPTION 'Investigation access denied'; END IF;
  IF nullif(trim(p_link_reason),'') IS NULL THEN RAISE EXCEPTION 'Link reason is required'; END IF;
  SELECT * INTO v_link FROM public.investigation_links WHERE investigation_id=p_investigation_id AND entity_type=p_entity_type AND entity_id=p_entity_id;
  IF FOUND THEN RETURN v_link; END IF;
  INSERT INTO public.investigation_links (investigation_id, organization_id, entity_type, entity_id, link_role, link_reason, linked_by)
  VALUES (p_investigation_id, v_item.organization_id, p_entity_type, p_entity_id, p_link_role, trim(p_link_reason), v_actor)
  RETURNING * INTO v_link;
  IF p_entity_type='field_report' THEN UPDATE public.officer_field_reports SET investigation_id=p_investigation_id WHERE id=p_entity_id AND organization_id=v_item.organization_id; END IF;
  IF p_entity_type='incident' THEN UPDATE public.incidents SET investigation_id=p_investigation_id WHERE id=p_entity_id AND organization_id=v_item.organization_id; END IF;
  INSERT INTO public.investigation_events (investigation_id, organization_id, event_type, description, source_table, source_id, created_by)
  VALUES (p_investigation_id, v_item.organization_id, 'entity_linked', p_entity_type || ' linked: ' || trim(p_link_reason), p_entity_type, p_entity_id, v_actor);
  RETURN v_link;
END;
$$;

CREATE OR REPLACE FUNCTION public.create_investigation_follow_up_job(
  p_investigation_id uuid,
  p_client_request_id uuid,
  p_service_agreement_id uuid,
  p_client_site_id uuid,
  p_job_type text,
  p_priority text,
  p_sla_minutes integer,
  p_briefing_notes text,
  p_dispatch_resource_id uuid DEFAULT NULL,
  p_shift_id uuid DEFAULT NULL
) RETURNS TABLE(id uuid, created boolean, status text, sla_respond_by timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_actor uuid := auth.uid(); v_item public.investigations%rowtype; v_job record;
BEGIN
  SELECT * INTO v_item FROM public.investigations WHERE public.investigations.id=p_investigation_id FOR SHARE;
  IF NOT FOUND OR v_actor IS NULL OR NOT public.is_admin_for_org(v_item.organization_id) THEN RAISE EXCEPTION 'Investigation access denied'; END IF;
  SELECT * INTO v_job FROM public.create_dispatch_job(v_item.organization_id, p_service_agreement_id, p_client_site_id, p_client_request_id, p_job_type, p_priority, p_sla_minutes, p_dispatch_resource_id, p_briefing_notes, p_shift_id);
  UPDATE public.dispatch_jobs SET investigation_id=p_investigation_id, origin_type='investigation_follow_up', origin_reference_id=p_investigation_id WHERE public.dispatch_jobs.id=v_job.id;
  PERFORM public.link_investigation_entity(p_investigation_id, 'dispatch_job', v_job.id, 'primary', 'Investigation-directed follow-up dispatch');
  RETURN QUERY SELECT v_job.id, v_job.created, v_job.status, v_job.sla_respond_by;
END;
$$;

REVOKE ALL ON FUNCTION public.create_investigation(uuid,uuid,text,text,text,text,text,uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.create_investigation(uuid,uuid,text,text,text,text,text,uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.link_investigation_entity(uuid,text,uuid,text,text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.link_investigation_entity(uuid,text,uuid,text,text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.create_investigation_follow_up_job(uuid,uuid,uuid,uuid,text,text,integer,text,uuid,uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.create_investigation_follow_up_job(uuid,uuid,uuid,uuid,text,text,integer,text,uuid,uuid) TO authenticated, service_role;
