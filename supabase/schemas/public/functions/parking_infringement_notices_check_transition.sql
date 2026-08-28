create or replace function public.parking_infringement_notices_check_transition()
  returns trigger
  language plpgsql
  AS $function$
begin
  -- Only check when status actually changes
  if old.status = new.status then
    return new;
  end if;

  -- Validate transition
  if old.status = 'draft' and new.status in ('issued', 'cancelled') then
    return new;
  elsif old.status = 'issued' and new.status in ('paid', 'disputed', 'cancelled') then
    return new;
  elsif old.status = 'disputed' and new.status in ('cancelled', 'paid') then
    return new;
  else
    raise exception 'Invalid notice status transition: % → %', old.status, new.status
      using hint = 'Allowed transitions: draft→issued/cancelled, issued→paid/disputed/cancelled, disputed→cancelled/paid. paid and cancelled are terminal.';
  end if;
end;
$function$;

grant execute on function "public"."parking_infringement_notices_check_transition"() to public, "anon", "authenticated", "postgres", "service_role";

comment on function "public"."parking_infringement_notices_check_transition"() is 'Enforces valid status transitions on parking_infringement_notices. Terminal states (paid, cancelled) cannot transition. 0233 E2 fix.';
