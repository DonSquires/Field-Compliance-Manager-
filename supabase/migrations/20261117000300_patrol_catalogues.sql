-- Place patrols and services, Task 3 (owner design 2026-11-16).
-- Two data catalogues later tasks read:
--   patrol_check_types    - the checks an officer ticks at a stop. Eight read-only defaults
--                           (organization_id NULL) plus each organisation's own types, written
--                           only through manage_patrol_check_type.
--   place_service_seasons - the season names schedule terms use, with their months.
-- active_check_keys_for lists the active default and organisation keys.

CREATE TABLE IF NOT EXISTS public.patrol_check_types(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES public.organizations(id),
  check_key text NOT NULL CHECK (check_key ~ '^[a-z][a-z0-9_]{1,40}$'),
  label text NOT NULL CHECK (char_length(btrim(label)) BETWEEN 1 AND 80),
  needs_photo boolean NOT NULL DEFAULT false,
  needs_note boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

COMMENT ON TABLE public.patrol_check_types IS
  'Checks an officer ticks at a patrol stop. Rows with no organisation are the read-only defaults; organisation rows are written only through manage_patrol_check_type. check_key never changes after creation.';

CREATE UNIQUE INDEX IF NOT EXISTS idx_patrol_check_types_org_key
  ON public.patrol_check_types ((coalesce(organization_id, '00000000-0000-0000-0000-000000000000'::uuid)), check_key);

ALTER TABLE public.patrol_check_types ENABLE ROW LEVEL SECURITY;

CREATE POLICY patrol_check_types_select ON public.patrol_check_types
  FOR SELECT TO authenticated
  USING (organization_id IS NULL
         OR public.user_can_operate_organization(organization_id)
         OR public.is_admin_for_org(organization_id));

REVOKE ALL ON TABLE public.patrol_check_types FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.patrol_check_types TO authenticated;
GRANT ALL ON TABLE public.patrol_check_types TO service_role;

INSERT INTO public.patrol_check_types(organization_id, check_key, label) VALUES
  (NULL, 'lock_up', 'Lock-up'),
  (NULL, 'unlock', 'Unlock'),
  (NULL, 'random_check', 'Random check'),
  (NULL, 'bed_down', 'Bed-down'),
  (NULL, 'welfare_check', 'Welfare check'),
  (NULL, 'gate_check', 'Gate check'),
  (NULL, 'key_pickup', 'Key pickup'),
  (NULL, 'key_return', 'Key return')
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS public.place_service_seasons(
  season_key text PRIMARY KEY,
  label text NOT NULL,
  months integer[] NOT NULL,
  sort_order integer NOT NULL
);

COMMENT ON TABLE public.place_service_seasons IS
  'Season names used by place service schedule terms, with the calendar months (1-12) each covers.';

ALTER TABLE public.place_service_seasons ENABLE ROW LEVEL SECURITY;

CREATE POLICY place_service_seasons_select ON public.place_service_seasons
  FOR SELECT TO authenticated USING (true);

REVOKE ALL ON TABLE public.place_service_seasons FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.place_service_seasons TO authenticated;
GRANT ALL ON TABLE public.place_service_seasons TO service_role;

INSERT INTO public.place_service_seasons(season_key, label, months, sort_order) VALUES
  ('summer', 'Summer', ARRAY[12, 1, 2], 1),
  ('autumn', 'Autumn', ARRAY[3, 4, 5], 2),
  ('winter', 'Winter', ARRAY[6, 7, 8], 3),
  ('spring', 'Spring', ARRAY[9, 10, 11], 4)
ON CONFLICT (season_key) DO NOTHING;

CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_patrol_check_type_request
  ON public.audit_log (organization_id, ((metadata ->> 'client_request_id')))
  WHERE action IN ('patrol_check_type_create', 'patrol_check_type_update', 'patrol_check_type_deactivate',
    'patrol_check_type_reactivate');

CREATE OR REPLACE FUNCTION public.manage_patrol_check_type(
  p_client_request_id uuid,
  p_action text,
  p_organization_id uuid,
  p_check_type_id uuid,
  p_label text,
  p_needs_photo boolean,
  p_needs_note boolean
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
declare
  v_actor uuid := auth.uid();
  v_label text := nullif(btrim(p_label), '');
  v_request jsonb;
  v_replay jsonb;
  v_key text;
  v_existing public.patrol_check_types%rowtype;
  v_row public.patrol_check_types%rowtype;
  v_result jsonb;
  v_reactivated boolean := false;
  v_clash_label text;
begin
  if v_actor is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if p_client_request_id is null or p_organization_id is null then
    raise exception 'Request ID and organisation are required' using errcode = '22023';
  end if;
  if p_action is null or p_action not in ('create', 'update', 'deactivate', 'reactivate') then
    raise exception 'Unknown check type action' using errcode = '22023';
  end if;
  if not public.is_admin_for_org(p_organization_id) then
    raise exception 'Organisation administrator required' using errcode = '42501';
  end if;

  v_request := jsonb_build_object('action', p_action, 'check_type_id', p_check_type_id, 'label', v_label,
    'needs_photo', p_needs_photo, 'needs_note', p_needs_note);

  perform pg_advisory_xact_lock(hashtextextended(p_client_request_id::text, 0));
  select audit.metadata into v_replay from public.audit_log audit
  where audit.organization_id = p_organization_id
    and audit.action in ('patrol_check_type_create', 'patrol_check_type_update', 'patrol_check_type_deactivate',
      'patrol_check_type_reactivate')
    and audit.metadata ->> 'client_request_id' = p_client_request_id::text;
  if found then
    if v_replay -> 'request' is distinct from v_request then
      raise exception 'Check type request identity collision' using errcode = '22023';
    end if;
    return v_replay -> 'result';
  end if;

  if v_label is not null and char_length(v_label) > 80 then
    raise exception 'Use a check name of 80 characters or fewer' using errcode = 'P0001';
  end if;

  if p_action = 'create' then
    if v_label is null then
      raise exception 'Use a check name that starts with a letter' using errcode = 'P0001';
    end if;
    v_key := btrim(regexp_replace(lower(v_label), '[^a-z0-9]+', '_', 'g'), '_');
    if v_key !~ '^[a-z][a-z0-9_]{1,40}$' then
      raise exception 'Use a check name that starts with a letter and is no longer than 40 letters or numbers' using errcode = 'P0001';
    end if;
    select * into v_existing from public.patrol_check_types t
    where t.check_key = v_key and (t.organization_id is null or t.organization_id = p_organization_id)
    order by t.organization_id nulls first
    limit 1
    for update;
    if found and (v_existing.organization_id is null or v_existing.active) then
      raise exception 'A check called % already exists', v_existing.label using errcode = 'P0001';
    end if;
    if found then
      -- The same organisation's inactive check with this key comes back with the new details.
      update public.patrol_check_types t
      set active = true,
          label = v_label,
          needs_photo = coalesce(p_needs_photo, false),
          needs_note = coalesce(p_needs_note, false),
          updated_at = clock_timestamp()
      where t.id = v_existing.id
      returning * into v_row;
      v_reactivated := true;
    else
      begin
        insert into public.patrol_check_types(organization_id, check_key, label, needs_photo, needs_note, created_by)
        values (p_organization_id, v_key, v_label, coalesce(p_needs_photo, false), coalesce(p_needs_note, false), v_actor)
        returning * into v_row;
      exception when unique_violation then
        select t.label into v_clash_label from public.patrol_check_types t
        where t.check_key = v_key and (t.organization_id is null or t.organization_id = p_organization_id)
        order by t.organization_id nulls first
        limit 1;
        raise exception 'A check called % already exists', coalesce(v_clash_label, v_label) using errcode = 'P0001';
      end;
    end if;
  else
    if p_check_type_id is null then
      raise exception 'Check type is required' using errcode = '22023';
    end if;
    select * into v_existing from public.patrol_check_types t where t.id = p_check_type_id for update;
    if found and v_existing.organization_id is null then
      raise exception 'Default check types cannot be changed' using errcode = 'P0001';
    end if;
    if not found or v_existing.organization_id is distinct from p_organization_id then
      raise exception 'Check type not found' using errcode = 'P0002';
    end if;
    if p_action = 'update' then
      if v_label is null and p_needs_photo is null and p_needs_note is null then
        raise exception 'Nothing to change' using errcode = '22023';
      end if;
      if v_label is not null then
        select t.label into v_clash_label from public.patrol_check_types t
        where t.id <> p_check_type_id
          and t.active
          and (t.organization_id is null or t.organization_id = p_organization_id)
          and lower(btrim(t.label)) = lower(v_label)
        order by t.organization_id nulls first
        limit 1;
        if found then
          raise exception 'A check called % already exists', v_clash_label using errcode = 'P0001';
        end if;
      end if;
      update public.patrol_check_types t
      set label = coalesce(v_label, t.label),
          needs_photo = coalesce(p_needs_photo, t.needs_photo),
          needs_note = coalesce(p_needs_note, t.needs_note),
          updated_at = clock_timestamp()
      where t.id = p_check_type_id
      returning * into v_row;
    elsif p_action = 'reactivate' then
      if v_existing.active then
        raise exception 'This check is already active' using errcode = 'P0001';
      end if;
      select t.label into v_clash_label from public.patrol_check_types t
      where t.id <> p_check_type_id
        and t.active
        and (t.organization_id is null or t.organization_id = p_organization_id)
        and (lower(btrim(t.label)) = lower(btrim(v_existing.label)) or t.check_key = v_existing.check_key)
      order by t.organization_id nulls first
      limit 1;
      if found then
        raise exception 'A check called % already exists', v_clash_label using errcode = 'P0001';
      end if;
      update public.patrol_check_types t
      set active = true,
          updated_at = clock_timestamp()
      where t.id = p_check_type_id
      returning * into v_row;
    else
      update public.patrol_check_types t
      set active = false,
          updated_at = clock_timestamp()
      where t.id = p_check_type_id
      returning * into v_row;
    end if;
  end if;

  v_result := jsonb_build_object('check_type_id', v_row.id, 'organization_id', v_row.organization_id,
    'check_key', v_row.check_key, 'label', v_row.label, 'needs_photo', v_row.needs_photo,
    'needs_note', v_row.needs_note, 'active', v_row.active);
  if p_action = 'create' then
    v_result := v_result || jsonb_build_object('reactivated', v_reactivated);
  end if;

  insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (p_organization_id, v_actor, 'patrol_check_type_' || p_action, 'patrol_check_types', v_row.id,
    jsonb_build_object('client_request_id', p_client_request_id, 'request', v_request, 'result', v_result));

  return v_result;
end;
$$;

COMMENT ON FUNCTION public.manage_patrol_check_type(uuid, text, uuid, uuid, text, boolean, boolean) IS
  'Creates, updates (label, needs_photo, needs_note), deactivates or reactivates an organisation''s own patrol check type as an administrator of that organisation. Default check types are read-only. create derives check_key from the label, refuses a clash with a default or active own key, and reactivates the organisation''s inactive check with that key (result reactivated: true). update refuses a label matching another active default or own label. reactivate turns an inactive own check back on with its saved details, refusing one that is already active or whose label or key now matches another active check. Audited as patrol_check_type_<action>; a replay of the same request ID with the same payload returns the first result.';

REVOKE ALL ON FUNCTION public.manage_patrol_check_type(uuid, text, uuid, uuid, text, boolean, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.manage_patrol_check_type(uuid, text, uuid, uuid, text, boolean, boolean) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.active_check_keys_for(p_organization_id uuid)
RETURNS text[]
LANGUAGE sql STABLE SET search_path = ''
AS $$
  select coalesce(array_agg(distinct t.check_key order by t.check_key), array[]::text[])
  from public.patrol_check_types t
  where t.active
    and (t.organization_id is null or t.organization_id = p_organization_id);
$$;

COMMENT ON FUNCTION public.active_check_keys_for(uuid) IS
  'Active default and organisation check keys, sorted. Runs as the caller, so row security limits organisation keys to organisations the caller may see.';

REVOKE ALL ON FUNCTION public.active_check_keys_for(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.active_check_keys_for(uuid) TO authenticated, service_role;
