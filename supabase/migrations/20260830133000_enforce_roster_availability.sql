create function public.staff_has_roster_availability_conflict(p_staff_id uuid,p_scheduled_start timestamptz,p_scheduled_end timestamptz)
returns boolean language sql stable security definer set search_path=public as $$
  select exists(
    select 1
    from public.staff_availability a
    cross join lateral generate_series(
      (p_scheduled_start at time zone 'Pacific/Auckland')::date,
      ((p_scheduled_end-interval '1 microsecond') at time zone 'Pacific/Auckland')::date,
      interval '1 day'
    ) as roster_day
    where a.staff_id=p_staff_id
      and a.availability_type in('unavailable','leave')
      and (a.specific_date=roster_day::date or (a.specific_date is null and a.day_of_week=extract(isodow from roster_day)::integer))
      and (
        a.all_day
        or a.available_from is null
        or a.available_to is null
        or tstzrange(p_scheduled_start,p_scheduled_end,'[)') && tstzrange(
          (roster_day::date+a.available_from) at time zone 'Pacific/Auckland',
          ((roster_day::date+case when a.available_to>a.available_from then 0 else 1 end)+a.available_to) at time zone 'Pacific/Auckland',
          '[)'
        )
      )
  );
$$;

create function public.enforce_roster_slot_availability()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if new.status not in('declined','cancelled') and public.staff_has_roster_availability_conflict(new.staff_id,new.scheduled_start,new.scheduled_end) then
    raise exception 'Staff member is unavailable during this roster slot';
  end if;
  return new;
end;$$;

create trigger trg_enforce_roster_slot_availability
before insert or update of staff_id,scheduled_start,scheduled_end,status on public.roster_slots
for each row execute function public.enforce_roster_slot_availability();

revoke all on function public.staff_has_roster_availability_conflict(uuid,timestamptz,timestamptz),public.enforce_roster_slot_availability() from public,anon,authenticated;
grant execute on function public.staff_has_roster_availability_conflict(uuid,timestamptz,timestamptz),public.enforce_roster_slot_availability() to service_role;