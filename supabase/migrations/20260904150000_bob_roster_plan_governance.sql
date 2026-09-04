-- Bob roster plans are governed drafts. Bob proposes, a human approves, and the
-- executor may only assign or roll back still-draft slots. Publication remains
-- exclusively human-operated through the existing roster slot lifecycle.

CREATE TABLE IF NOT EXISTS public.bob_roster_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  action_id uuid NOT NULL UNIQUE REFERENCES public.bob_agentic_actions(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'applied',
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  applied_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  rolled_back_at timestamptz,
  rolled_back_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  rollback_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bob_roster_plans_status_check CHECK (status IN ('applied', 'rolled_back')),
  CONSTRAINT bob_roster_plans_period_check CHECK (period_end > period_start)
);

CREATE TABLE IF NOT EXISTS public.bob_roster_plan_slots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL REFERENCES public.bob_roster_plans(id) ON DELETE CASCADE,
  roster_slot_id uuid NOT NULL REFERENCES public.roster_slots(id) ON DELETE RESTRICT,
  staff_id uuid NOT NULL REFERENCES public.staff_profiles(id) ON DELETE RESTRICT,
  score numeric(8,2) NOT NULL,
  rationale text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  rolled_back_at timestamptz,
  UNIQUE(plan_id, roster_slot_id)
);

CREATE INDEX IF NOT EXISTS idx_bob_roster_plans_org_period
  ON public.bob_roster_plans(organization_id, period_start, period_end);
CREATE INDEX IF NOT EXISTS idx_bob_roster_plan_slots_slot
  ON public.bob_roster_plan_slots(roster_slot_id) WHERE rolled_back_at IS NULL;

ALTER TABLE public.bob_roster_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bob_roster_plan_slots ENABLE ROW LEVEL SECURITY;

CREATE POLICY bob_roster_plans_select ON public.bob_roster_plans FOR SELECT TO authenticated
  USING (public.is_admin_for_org(organization_id));
CREATE POLICY bob_roster_plan_slots_select ON public.bob_roster_plan_slots FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.bob_roster_plans p WHERE p.id = plan_id AND public.is_admin_for_org(p.organization_id)));

REVOKE ALL ON public.bob_roster_plans, public.bob_roster_plan_slots FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.bob_roster_plans, public.bob_roster_plan_slots TO authenticated;
GRANT ALL ON public.bob_roster_plans, public.bob_roster_plan_slots TO service_role;

CREATE OR REPLACE FUNCTION public.get_bob_roster_fill_candidates(
  p_organization_id uuid,
  p_from timestamptz,
  p_to timestamptz
)
RETURNS TABLE(
  roster_slot_id uuid,
  work_unit_id uuid,
  scheduled_start timestamptz,
  scheduled_end timestamptz,
  staff_id uuid,
  score numeric,
  rationale text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
begin
  if not public.is_admin_for_org(p_organization_id) then
    raise exception 'Active roster administrator required';
  end if;

  if p_to <= p_from or p_to - p_from > interval '31 days' then
    raise exception 'Roster planning window must be greater than zero and no more than 31 days';
  end if;

  return query
  select
    slot.id,
    slot.work_unit_id,
    slot.scheduled_start,
    slot.scheduled_end,
    staff.id,
    (
      100
      - coalesce(extract(epoch from (now()::date - staff.seniority_date)) / 86400 / 3650, 0)
      - coalesce((select count(*) from public.roster_slots assigned where assigned.staff_id = staff.id and assigned.status not in ('declined', 'cancelled') and assigned.scheduled_start >= p_from and assigned.scheduled_start < p_to), 0) * 3
    )::numeric(8,2),
    concat_ws('; ',
      'work-ready',
      'current credentials/training required by roster gate',
      'available',
      'fatigue clear',
      case when staff.seniority_date is null then 'seniority date unavailable' else 'balanced by current scheduled load and seniority' end
    )
  from public.roster_slots slot
  join public.staff_profiles staff on staff.organization_id = slot.organization_id
  where slot.organization_id = p_organization_id
    and slot.staff_id is null
    and slot.status = 'draft'
    and slot.scheduled_start >= p_from
    and slot.scheduled_start < p_to
    and staff.work_ready = true
    and staff.overtime_eligible = true
    and (staff.end_date is null or staff.end_date >= (slot.scheduled_start at time zone 'Pacific/Auckland')::date)
    and not public.staff_has_roster_availability_conflict(staff.id, slot.scheduled_start, slot.scheduled_end)
    and public.staff_fatigue_conflict(staff.id, slot.scheduled_start, slot.scheduled_end, slot.id) is null
    and not exists (
      select 1 from public.roster_slots occupied
      where occupied.staff_id = staff.id
        and occupied.status not in ('declined', 'cancelled')
        and tstzrange(occupied.scheduled_start, occupied.scheduled_end, '[)')
            && tstzrange(slot.scheduled_start, slot.scheduled_end, '[)')
    )
  order by slot.scheduled_start, score desc, staff.seniority_date asc nulls last, staff.id;
end;
$$;

REVOKE ALL ON FUNCTION public.get_bob_roster_fill_candidates(uuid,timestamptz,timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_bob_roster_fill_candidates(uuid,timestamptz,timestamptz) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apply_bob_roster_fill_plan(p_action_id uuid)
RETURNS TABLE(plan_id uuid, assignments_applied integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
declare
  v_action public.bob_agentic_actions%rowtype;
  v_payload jsonb;
  v_plan public.bob_roster_plans%rowtype;
  v_item jsonb;
  v_slot public.roster_slots%rowtype;
  v_staff public.staff_profiles%rowtype;
  v_count integer := 0;
  v_actor uuid;
begin
  select a.* into v_action from public.bob_agentic_actions a where a.id = p_action_id for update;
  if not found then raise exception 'Bob action not found'; end if;
  if v_action.action_type <> 'apply_roster_fill_plan' or v_action.status <> 'approved' then
    raise exception 'Only approved apply_roster_fill_plan actions can be executed';
  end if;

  select p.* into v_plan from public.bob_roster_plans p where p.action_id = v_action.id;
  if found then
    return query select v_plan.id, (select count(*)::integer from public.bob_roster_plan_slots where plan_id = v_plan.id);
    return;
  end if;

  v_payload := coalesce(v_action.amended_payload, v_action.proposed_payload);
  if jsonb_typeof(v_payload->'assignments') <> 'array' or jsonb_array_length(v_payload->'assignments') = 0 then
    raise exception 'Roster plan requires at least one assignment';
  end if;

  v_actor := v_action.approved_by;
  insert into public.bob_roster_plans(organization_id, action_id, period_start, period_end, applied_by)
  values (
    v_action.organization_id, v_action.id,
    (v_payload->>'period_start')::timestamptz,
    (v_payload->>'period_end')::timestamptz,
    v_actor
  ) returning * into v_plan;

  for v_item in select value from jsonb_array_elements(v_payload->'assignments') loop
    select s.* into v_slot from public.roster_slots s where s.id = (v_item->>'roster_slot_id')::uuid for update;
    if not found or v_slot.organization_id <> v_action.organization_id then
      raise exception 'Proposed roster slot is unavailable';
    end if;
    if v_slot.status <> 'draft' or v_slot.staff_id is not null then
      raise exception 'Roster slot % changed after Bob proposed it; revise the plan', v_slot.id;
    end if;

    select sp.* into v_staff from public.staff_profiles sp where sp.id = (v_item->>'staff_id')::uuid;
    if not found or v_staff.organization_id <> v_action.organization_id or not v_staff.work_ready then
      raise exception 'Proposed staff member is unavailable';
    end if;
    if public.staff_has_roster_availability_conflict(v_staff.id, v_slot.scheduled_start, v_slot.scheduled_end)
      or public.staff_fatigue_conflict(v_staff.id, v_slot.scheduled_start, v_slot.scheduled_end, v_slot.id) is not null then
      raise exception 'Proposed staff member no longer meets availability or fatigue requirements';
    end if;

    update public.roster_slots set staff_id = v_staff.id where id = v_slot.id;
    insert into public.bob_roster_plan_slots(plan_id, roster_slot_id, staff_id, score, rationale)
    values (v_plan.id, v_slot.id, v_staff.id, coalesce((v_item->>'score')::numeric, 0), coalesce(nullif(trim(v_item->>'rationale'), ''), 'Bob roster proposal'));
    v_count := v_count + 1;
  end loop;

  insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (v_action.organization_id, v_actor, 'bob_roster_plan_applied', 'bob_roster_plans', v_plan.id,
    jsonb_build_object('action_id', v_action.id, 'assignments_applied', v_count));

  return query select v_plan.id, v_count;
end;
$$;

REVOKE ALL ON FUNCTION public.apply_bob_roster_fill_plan(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_bob_roster_fill_plan(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.rollback_bob_roster_fill_plan(p_action_id uuid)
RETURNS TABLE(plan_id uuid, assignments_rolled_back integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
declare
  v_action public.bob_agentic_actions%rowtype;
  v_plan public.bob_roster_plans%rowtype;
  v_item public.bob_roster_plan_slots%rowtype;
  v_slot public.roster_slots%rowtype;
  v_count integer := 0;
begin
  select a.* into v_action from public.bob_agentic_actions a where a.id = p_action_id for update;
  if not found then raise exception 'Bob action not found'; end if;
  if v_action.action_type <> 'rollback_bob_roster_plan' or v_action.status <> 'approved' then
    raise exception 'Only approved rollback_bob_roster_plan actions can be executed';
  end if;

  select p.* into v_plan from public.bob_roster_plans p
  where p.id = (coalesce(v_action.amended_payload, v_action.proposed_payload)->>'plan_id')::uuid
    and p.organization_id = v_action.organization_id
  for update;
  if not found then raise exception 'Bob roster plan not found'; end if;
  if v_plan.status <> 'applied' then raise exception 'Bob roster plan is already rolled back'; end if;

  for v_item in select * from public.bob_roster_plan_slots where plan_id = v_plan.id and rolled_back_at is null loop
    select s.* into v_slot from public.roster_slots s where s.id = v_item.roster_slot_id for update;
    if not found or v_slot.status <> 'draft' or v_slot.staff_id is distinct from v_item.staff_id then
      raise exception 'Roster slot % was edited or published after plan application; it cannot be rolled back automatically', v_item.roster_slot_id;
    end if;
    update public.roster_slots set staff_id = null where id = v_slot.id;
    update public.bob_roster_plan_slots set rolled_back_at = now() where id = v_item.id;
    v_count := v_count + 1;
  end loop;

  update public.bob_roster_plans
  set status = 'rolled_back', rolled_back_at = now(), rolled_back_by = v_action.approved_by,
      rollback_reason = nullif(trim(coalesce(coalesce(v_action.amended_payload, v_action.proposed_payload)->>'reason', '')), '')
  where id = v_plan.id;

  insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (v_action.organization_id, v_action.approved_by, 'bob_roster_plan_rolled_back', 'bob_roster_plans', v_plan.id,
    jsonb_build_object('action_id', v_action.id, 'assignments_rolled_back', v_count));

  return query select v_plan.id, v_count;
end;
$$;

REVOKE ALL ON FUNCTION public.rollback_bob_roster_fill_plan(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rollback_bob_roster_fill_plan(uuid) TO service_role;
