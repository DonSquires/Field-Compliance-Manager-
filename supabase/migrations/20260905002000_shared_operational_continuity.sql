-- Cross-tenant continuity is a derived, location/module-scoped projection.
-- Source records remain owned and editable only by their authoring tenant.
CREATE TABLE IF NOT EXISTS public.service_agreement_continuity_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_agreement_location_id uuid NOT NULL REFERENCES public.service_agreement_locations(id) ON DELETE CASCADE,
  service_agreement_module_id uuid NOT NULL REFERENCES public.service_agreement_modules(id) ON DELETE CASCADE,
  continuity_mode text NOT NULL DEFAULT 'none' CHECK (continuity_mode IN ('none', 'handoff_only', 'live_read', 'live_read_and_receive')),
  client_coverage_start time,
  client_coverage_end time,
  provider_coverage_start time,
  provider_coverage_end time,
  share_active_cases boolean NOT NULL DEFAULT false,
  share_open_tasks boolean NOT NULL DEFAULT false,
  share_recent_history_hours integer NOT NULL DEFAULT 24 CHECK (share_recent_history_hours BETWEEN 1 AND 168),
  share_attachments_mode text NOT NULL DEFAULT 'none' CHECK (share_attachments_mode IN ('none', 'redacted', 'selected_only')),
  share_presence_mode text NOT NULL DEFAULT 'none' CHECK (share_presence_mode IN ('none', 'on_duty_only')),
  require_handoff_ack boolean NOT NULL DEFAULT true,
  continuity_retention_hours integer NOT NULL DEFAULT 24 CHECK (continuity_retention_hours BETWEEN 1 AND 168),
  created_by uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  updated_by uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT continuity_policy_scope_unique UNIQUE (service_agreement_location_id, service_agreement_module_id),
  CONSTRAINT continuity_client_window_complete CHECK ((client_coverage_start IS NULL) = (client_coverage_end IS NULL)),
  CONSTRAINT continuity_provider_window_complete CHECK ((provider_coverage_start IS NULL) = (provider_coverage_end IS NULL))
);

CREATE TABLE IF NOT EXISTS public.operational_continuity_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id uuid NOT NULL REFERENCES public.service_agreement_continuity_policies(id) ON DELETE RESTRICT,
  service_agreement_id uuid NOT NULL REFERENCES public.service_agreements(id) ON DELETE RESTRICT,
  source_organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  recipient_organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  source_location_event_id uuid NOT NULL REFERENCES public.location_events(id) ON DELETE RESTRICT,
  client_site_id uuid REFERENCES public.client_sites(id) ON DELETE RESTRICT,
  zone_id uuid REFERENCES public.location_zones(id) ON DELETE RESTRICT,
  module_key text NOT NULL,
  operational_status text NOT NULL DEFAULT 'active' CHECK (operational_status IN ('active', 'resolved', 'superseded', 'expired')),
  severity text NOT NULL DEFAULT 'standard' CHECK (severity IN ('low', 'standard', 'high', 'critical')),
  safe_summary text NOT NULL CHECK (char_length(trim(safe_summary)) BETWEEN 1 AND 2000),
  hazard_flags jsonb NOT NULL DEFAULT '[]'::jsonb,
  action_required text,
  source_occurred_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  created_by uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT continuity_item_location_xor CHECK ((client_site_id IS NOT NULL) <> (zone_id IS NOT NULL)),
  CONSTRAINT continuity_item_source_unique UNIQUE (source_location_event_id, recipient_organization_id)
);

CREATE TABLE IF NOT EXISTS public.operational_continuity_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  continuity_item_id uuid NOT NULL REFERENCES public.operational_continuity_items(id) ON DELETE CASCADE,
  recipient_organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  acknowledged_by uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  acknowledged_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  continuation_location_event_id uuid REFERENCES public.location_events(id) ON DELETE SET NULL,
  acknowledgement_notes text,
  client_request_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT continuity_receipt_recipient_unique UNIQUE (continuity_item_id, recipient_organization_id),
  CONSTRAINT continuity_receipt_request_unique UNIQUE (recipient_organization_id, client_request_id)
);

CREATE INDEX IF NOT EXISTS idx_continuity_items_recipient_active ON public.operational_continuity_items(recipient_organization_id, operational_status, expires_at DESC);
CREATE INDEX IF NOT EXISTS idx_continuity_items_source_event ON public.operational_continuity_items(source_location_event_id);

ALTER TABLE public.service_agreement_continuity_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.operational_continuity_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.operational_continuity_receipts ENABLE ROW LEVEL SECURITY;

CREATE POLICY continuity_policies_select ON public.service_agreement_continuity_policies FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.service_agreement_locations sal JOIN public.service_agreements agreement ON agreement.id = sal.service_agreement_id WHERE sal.id = service_agreement_location_id AND (public.is_admin_for_org(agreement.provider_organization_id) OR public.is_admin_for_org(agreement.client_organization_id))));
CREATE POLICY continuity_items_select ON public.operational_continuity_items FOR SELECT TO authenticated
  USING (public.is_admin_for_org(source_organization_id) OR (public.is_admin_for_org(recipient_organization_id) AND expires_at >= now()));
CREATE POLICY continuity_receipts_select ON public.operational_continuity_receipts FOR SELECT TO authenticated
  USING (public.is_admin_for_org(recipient_organization_id));

REVOKE ALL ON TABLE public.service_agreement_continuity_policies, public.operational_continuity_items, public.operational_continuity_receipts FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.service_agreement_continuity_policies, public.operational_continuity_items, public.operational_continuity_receipts TO authenticated;
GRANT ALL ON TABLE public.service_agreement_continuity_policies, public.operational_continuity_items, public.operational_continuity_receipts TO service_role;

CREATE OR REPLACE FUNCTION public.continuity_party_on_duty(p_start time, p_end time, p_at timestamptz)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN p_start IS NULL OR p_end IS NULL OR p_start = p_end THEN true
    WHEN p_start < p_end THEN (p_at AT TIME ZONE 'Pacific/Auckland')::time >= p_start AND (p_at AT TIME ZONE 'Pacific/Auckland')::time < p_end
    ELSE (p_at AT TIME ZONE 'Pacific/Auckland')::time >= p_start OR (p_at AT TIME ZONE 'Pacific/Auckland')::time < p_end
  END;
$$;

CREATE OR REPLACE FUNCTION public.manage_service_agreement_continuity_policy(
  p_service_agreement_location_id uuid, p_service_agreement_module_id uuid, p_continuity_mode text,
  p_client_coverage_start time DEFAULT NULL, p_client_coverage_end time DEFAULT NULL,
  p_provider_coverage_start time DEFAULT NULL, p_provider_coverage_end time DEFAULT NULL,
  p_share_active_cases boolean DEFAULT false, p_share_open_tasks boolean DEFAULT false,
  p_share_recent_history_hours integer DEFAULT 24, p_share_attachments_mode text DEFAULT 'none',
  p_share_presence_mode text DEFAULT 'none', p_require_handoff_ack boolean DEFAULT true,
  p_continuity_retention_hours integer DEFAULT 24
) RETURNS public.service_agreement_continuity_policies
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
declare v_actor uuid := auth.uid(); v_location public.service_agreement_locations%rowtype; v_module public.service_agreement_modules%rowtype; v_row public.service_agreement_continuity_policies%rowtype;
begin
  select * into v_location from public.service_agreement_locations where id = p_service_agreement_location_id for update;
  if not found then raise exception 'Agreement location not found'; end if;
  select * into v_module from public.service_agreement_modules where id = p_service_agreement_module_id;
  if not found or v_module.service_agreement_id <> v_location.service_agreement_id then raise exception 'Module does not belong to this agreement location'; end if;
  if not exists (select 1 from public.service_agreements agreement where agreement.id = v_location.service_agreement_id and public.is_admin_for_org(agreement.provider_organization_id)) then raise exception 'Only the servicing provider can configure continuity policy'; end if;
  if p_continuity_mode <> 'none' and not v_module.enabled then raise exception 'Continuity requires an enabled agreement module'; end if;
  insert into public.service_agreement_continuity_policies(service_agreement_location_id,service_agreement_module_id,continuity_mode,client_coverage_start,client_coverage_end,provider_coverage_start,provider_coverage_end,share_active_cases,share_open_tasks,share_recent_history_hours,share_attachments_mode,share_presence_mode,require_handoff_ack,continuity_retention_hours,created_by,updated_by)
  values(p_service_agreement_location_id,p_service_agreement_module_id,p_continuity_mode,p_client_coverage_start,p_client_coverage_end,p_provider_coverage_start,p_provider_coverage_end,p_share_active_cases,p_share_open_tasks,p_share_recent_history_hours,p_share_attachments_mode,p_share_presence_mode,p_require_handoff_ack,p_continuity_retention_hours,v_actor,v_actor)
  on conflict(service_agreement_location_id,service_agreement_module_id) do update set continuity_mode=excluded.continuity_mode,client_coverage_start=excluded.client_coverage_start,client_coverage_end=excluded.client_coverage_end,provider_coverage_start=excluded.provider_coverage_start,provider_coverage_end=excluded.provider_coverage_end,share_active_cases=excluded.share_active_cases,share_open_tasks=excluded.share_open_tasks,share_recent_history_hours=excluded.share_recent_history_hours,share_attachments_mode=excluded.share_attachments_mode,share_presence_mode=excluded.share_presence_mode,require_handoff_ack=excluded.require_handoff_ack,continuity_retention_hours=excluded.continuity_retention_hours,updated_by=v_actor,updated_at=clock_timestamp()
  returning * into v_row;
  insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata) values((select provider_organization_id from public.service_agreements where id=v_location.service_agreement_id),v_actor,'service_agreement_continuity_policy_managed','service_agreement_continuity_policies',v_row.id,jsonb_build_object('agreement_location_id',v_location.id,'agreement_module_id',v_module.id,'mode',v_row.continuity_mode));
  return v_row;
end; $$;

CREATE OR REPLACE FUNCTION public.publish_location_event_continuity(p_client_request_id uuid, p_location_event_id uuid, p_safe_summary text, p_severity text DEFAULT 'standard', p_hazard_flags jsonb DEFAULT '[]'::jsonb, p_action_required text DEFAULT NULL)
RETURNS public.operational_continuity_items
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
declare v_actor uuid:=auth.uid(); v_event public.location_events%rowtype; v_policy public.service_agreement_continuity_policies%rowtype; v_agreement public.service_agreements%rowtype; v_recipient uuid; v_item public.operational_continuity_items%rowtype;
begin
  if p_client_request_id is null then raise exception 'client_request_id is required'; end if;
  select * into v_event from public.location_events where id=p_location_event_id for update;
  if not found or not public.is_admin_for_org(v_event.organization_id) then raise exception 'Event not found in your organization'; end if;
  select policy.* into v_policy from public.service_agreement_continuity_policies policy join public.service_agreement_locations location on location.id=policy.service_agreement_location_id join public.service_agreement_modules module on module.id=policy.service_agreement_module_id and module.service_agreement_id=location.service_agreement_id and module.enabled and module.module_key=v_event.module_key join public.service_agreements agreement on agreement.id=location.service_agreement_id and agreement.invitation_status='accepted' where policy.continuity_mode in ('live_read','live_read_and_receive') and (location.site_id=v_event.client_site_id or location.zone_id=v_event.zone_id) and (agreement.provider_organization_id=v_event.organization_id or agreement.client_organization_id=v_event.organization_id) order by policy.updated_at desc limit 1;
  if not found then raise exception 'No active continuity policy covers this event location and module'; end if;
  select * into v_agreement from public.service_agreements where id = (select service_agreement_id from public.service_agreement_locations where id = v_policy.service_agreement_location_id);
  if v_event.organization_id=v_agreement.provider_organization_id then
    if not public.continuity_party_on_duty(v_policy.provider_coverage_start,v_policy.provider_coverage_end,v_event.occurred_at) then raise exception 'Provider coverage window is not active'; end if;
    v_recipient:=v_agreement.client_organization_id;
  else
    if not public.continuity_party_on_duty(v_policy.client_coverage_start,v_policy.client_coverage_end,v_event.occurred_at) then raise exception 'Client coverage window is not active'; end if;
    v_recipient:=v_agreement.provider_organization_id;
  end if;
  insert into public.operational_continuity_items(policy_id,service_agreement_id,source_organization_id,recipient_organization_id,source_location_event_id,client_site_id,zone_id,module_key,severity,safe_summary,hazard_flags,action_required,source_occurred_at,expires_at,created_by)
  values(v_policy.id,v_agreement.id,v_event.organization_id,v_recipient,v_event.id,v_event.client_site_id,v_event.zone_id,v_event.module_key,p_severity,trim(p_safe_summary),coalesce(p_hazard_flags,'[]'::jsonb),nullif(trim(coalesce(p_action_required,'')),''),v_event.occurred_at,v_event.occurred_at+(v_policy.continuity_retention_hours||' hours')::interval,v_actor)
  on conflict(source_location_event_id,recipient_organization_id) do update set safe_summary=excluded.safe_summary,severity=excluded.severity,hazard_flags=excluded.hazard_flags,action_required=excluded.action_required,operational_status='active',expires_at=excluded.expires_at
  returning * into v_item;
  insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata) values(v_event.organization_id,v_actor,'location_event_continuity_published','operational_continuity_items',v_item.id,jsonb_build_object('location_event_id',v_event.id,'recipient_organization_id',v_recipient,'policy_id',v_policy.id));
  return v_item;
end; $$;

CREATE OR REPLACE FUNCTION public.acknowledge_operational_continuity_item(p_client_request_id uuid,p_continuity_item_id uuid,p_acknowledgement_notes text DEFAULT NULL,p_continuation_location_event_id uuid DEFAULT NULL)
RETURNS public.operational_continuity_receipts
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
declare v_actor uuid:=auth.uid(); v_item public.operational_continuity_items%rowtype; v_receipt public.operational_continuity_receipts%rowtype;
begin
  if p_client_request_id is null then raise exception 'client_request_id is required'; end if;
  select * into v_receipt from public.operational_continuity_receipts where recipient_organization_id = (select recipient_organization_id from public.operational_continuity_items where id = p_continuity_item_id) and client_request_id = p_client_request_id;
  if found then return v_receipt; end if;
  select * into v_item from public.operational_continuity_items where id=p_continuity_item_id for update;
  if not found or not public.is_admin_for_org(v_item.recipient_organization_id) then raise exception 'Continuity item not available to your organization'; end if;
  insert into public.operational_continuity_receipts(continuity_item_id,recipient_organization_id,acknowledged_by,continuation_location_event_id,acknowledgement_notes,client_request_id)
  values(v_item.id,v_item.recipient_organization_id,v_actor,p_continuation_location_event_id,nullif(trim(coalesce(p_acknowledgement_notes,'')),''),p_client_request_id)
  returning * into v_receipt;
  insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata) values(v_item.recipient_organization_id,v_actor,'operational_continuity_acknowledged','operational_continuity_receipts',v_receipt.id,jsonb_build_object('continuity_item_id',v_item.id,'source_organization_id',v_item.source_organization_id));
  return v_receipt;
end; $$;

REVOKE ALL ON FUNCTION public.continuity_party_on_duty(time,time,timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.manage_service_agreement_continuity_policy(uuid,uuid,text,time,time,time,time,boolean,boolean,integer,text,text,boolean,integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.publish_location_event_continuity(uuid,uuid,text,text,jsonb,text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.acknowledge_operational_continuity_item(uuid,uuid,text,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.manage_service_agreement_continuity_policy(uuid,uuid,text,time,time,time,time,boolean,boolean,integer,text,text,boolean,integer), public.publish_location_event_continuity(uuid,uuid,text,text,jsonb,text), public.acknowledge_operational_continuity_item(uuid,uuid,text,uuid) TO authenticated, service_role;
