-- Notify affected officers when roster ownership, timing, or lifecycle changes.

create or replace function public.tg_notify_roster_slot_change()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_user_id uuid;
  v_title text;
  v_body text;
  v_kind text;
begin
  if tg_op <> 'UPDATE' then return new; end if;
  if new.staff_id is not distinct from old.staff_id
     and new.scheduled_start is not distinct from old.scheduled_start
     and new.scheduled_end is not distinct from old.scheduled_end
     and new.status is not distinct from old.status then return new; end if;

  select sp.user_id into v_user_id from public.staff_profiles sp where sp.id = new.staff_id;
  if v_user_id is null then return new; end if;
  v_kind := case when new.staff_id is distinct from old.staff_id then 'reassigned' when new.status = 'cancelled' then 'cancelled' when new.status = 'published' and old.status = 'draft' then 'published' when new.scheduled_start is distinct from old.scheduled_start or new.scheduled_end is distinct from old.scheduled_end then 'updated' else new.status end;
  v_title := 'Roster assignment ' || v_kind;
  v_body := case when v_kind = 'cancelled' then 'A roster assignment has been cancelled.' when v_kind = 'reassigned' then 'A roster assignment has been reassigned to you.' else 'A roster assignment has changed. Review your schedule.' end;
  perform public.enqueue_notification(p_organization_id => new.organization_id, p_category => 'roster', p_title => v_title, p_body => v_body, p_severity => case when v_kind = 'cancelled' then 'warning' else 'info' end, p_recipient_user_id => v_user_id, p_link_page => 'schedule', p_link_payload => jsonb_build_object('roster_slot_id', new.id, 'status', new.status), p_dedup_key => 'roster_slot_change:' || new.id::text || ':' || v_kind || ':' || coalesce(new.updated_at::text, now()::text));
  return new;
end;
$$;

drop trigger if exists trg_notify_roster_slot_change on public.roster_slots;
create trigger trg_notify_roster_slot_change after update on public.roster_slots for each row execute function public.tg_notify_roster_slot_change();

create or replace function public.tg_notify_shift_change()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare v_user_id uuid; v_kind text;
begin
  if tg_op <> 'UPDATE' then return new; end if;
  if new.officer_user_id is not distinct from old.officer_user_id and new.scheduled_start is not distinct from old.scheduled_start and new.scheduled_end is not distinct from old.scheduled_end and new.status is not distinct from old.status then return new; end if;
  v_user_id := new.officer_user_id;
  if v_user_id is null then return new; end if;
  v_kind := case when new.officer_user_id is distinct from old.officer_user_id then 'ownership' when new.status = 'cancelled' then 'cancelled' when new.status = 'in_progress' then 'started' when new.status = 'completed' then 'completed' when new.scheduled_start is distinct from old.scheduled_start or new.scheduled_end is distinct from old.scheduled_end then 'timing' else new.status end;
  perform public.enqueue_notification(p_organization_id => new.organization_id, p_category => 'roster', p_title => 'Shift ' || v_kind, p_body => case when v_kind = 'cancelled' then 'A field shift has been cancelled.' when v_kind = 'completed' then 'Your shift has been completed and is ready for timesheet review.' else 'Your field shift has changed. Review your schedule.' end, p_severity => case when v_kind = 'cancelled' then 'warning' else 'info' end, p_recipient_user_id => v_user_id, p_link_page => 'schedule', p_link_payload => jsonb_build_object('shift_id', new.id, 'status', new.status), p_dedup_key => 'shift_change:' || new.id::text || ':' || v_kind || ':' || new.updated_at::text);
  return new;
end;
$$;

drop trigger if exists trg_notify_shift_change on public.shifts;
create trigger trg_notify_shift_change after update on public.shifts for each row execute function public.tg_notify_shift_change();
