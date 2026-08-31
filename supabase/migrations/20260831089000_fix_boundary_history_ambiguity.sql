create or replace function public.get_boundary_history (
  p_entity_type text,
  p_entity_id uuid
)
returns table (
  id uuid,
  entity_type text,
  entity_id uuid,
  boundary_source text,
  verification_state text,
  verified_by uuid,
  verified_at timestamptz,
  changed_by uuid,
  changed_via text,
  change_reason text,
  version integer,
  created_at timestamptz,
  has_boundary boolean
)
language plpgsql stable security definer set search_path=public as $$
declare v_org_id uuid;
begin
  if p_entity_type='organization' then
    if not public.org_access_allowed(p_entity_id) then raise exception 'get_boundary_history: access denied for organization %',p_entity_id;end if;
  elsif p_entity_type='location_zone' then
    select z.organization_id into v_org_id from public.location_zones z where z.id=p_entity_id;
    if not found or not public.org_access_allowed(v_org_id) then raise exception 'get_boundary_history: access denied for location_zone %',p_entity_id;end if;
  elsif p_entity_type='client_site' then
    select s.client_organization_id into v_org_id from public.client_sites s where s.id=p_entity_id;
    if not found or not public.org_access_allowed(v_org_id) then raise exception 'get_boundary_history: access denied for client_site %',p_entity_id;end if;
  else raise exception 'get_boundary_history: unknown entity_type "%"',p_entity_type;
  end if;
  return query select h.id,h.entity_type,h.entity_id,h.boundary_source,h.verification_state,h.verified_by,h.verified_at,h.changed_by,h.changed_via,h.change_reason,h.version,h.created_at,(h.boundary is not null)
  from public.geofence_boundary_history h where h.entity_type=p_entity_type and h.entity_id=p_entity_id order by h.created_at desc,h.version desc;
end;$$;

grant execute on function public.get_boundary_history(text,uuid) to public,anon,authenticated,postgres,service_role;