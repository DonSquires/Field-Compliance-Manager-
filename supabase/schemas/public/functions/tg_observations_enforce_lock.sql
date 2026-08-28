create or replace function public.tg_observations_enforce_lock()
  returns trigger
  language plpgsql
  AS $function$
begin
  -- CONDITION A: post-lock edit (row was already locked before this UPDATE).
  if old.locked_at is not null then
    -- Block clearing or rewriting locked_at.
    if new.locked_at is distinct from old.locked_at then
      raise exception
        'observation % is locked. locked_at may not be cleared or rewritten. Use the authorised correction path.',
        old.id
        using errcode = 'P0001';
    end if;
    -- Block changes to frozen fact fields.
    if (
      new.observed_at       is distinct from old.observed_at       or
      new.gps_lat           is distinct from old.gps_lat           or
      new.gps_lng           is distinct from old.gps_lng           or
      new.plate_number      is distinct from old.plate_number      or
      new.is_compliant      is distinct from old.is_compliant      or
      new.compliance_reason is distinct from old.compliance_reason or
      new.officer_id        is distinct from old.officer_id        or
      new.zone_id           is distinct from old.zone_id
    ) then
      raise exception
        'observation % is locked (locked_at = %). Frozen fact fields may not be edited after lock. Authorised corrections require the correction workflow (Part 2, not yet built).',
        old.id, old.locked_at
        using errcode = 'P0001';
    end if;
  end if;

  -- CONDITION B: lock-transition tamper (this UPDATE causes the row to become locked).
  -- The normal completion write sets photo fields only and must pass through.
  -- A tampered write that also changes frozen fields must be blocked.
  if old.locked_at is null and new.locked_at is not null then
    if (
      new.observed_at       is distinct from old.observed_at       or
      new.gps_lat           is distinct from old.gps_lat           or
      new.gps_lng           is distinct from old.gps_lng           or
      new.plate_number      is distinct from old.plate_number      or
      new.is_compliant      is distinct from old.is_compliant      or
      new.compliance_reason is distinct from old.compliance_reason or
      new.officer_id        is distinct from old.officer_id        or
      new.zone_id           is distinct from old.zone_id
    ) then
      raise exception
        'observation % cannot be locked with mutated frozen fields. Frozen fact fields must be unchanged at the moment of lock.',
        old.id
        using errcode = 'P0001';
    end if;
  end if;

  return new;
end;
$function$;

grant execute on function "public"."tg_observations_enforce_lock"() to public, "anon", "authenticated", "postgres", "service_role";
