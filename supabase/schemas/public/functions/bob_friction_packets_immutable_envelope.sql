create or replace function public.bob_friction_packets_immutable_envelope()
  returns trigger
  language plpgsql
  security definer
  set search_path to 'public'
  AS $function$
begin
  if OLD.envelope is distinct from NEW.envelope then
    raise exception 'envelope column is immutable once written'
      using errcode = 'restrict_violation';
  end if;
  return NEW;
end;
$function$;

grant execute on function "public"."bob_friction_packets_immutable_envelope"() to public, "anon", "authenticated", "postgres", "service_role";
