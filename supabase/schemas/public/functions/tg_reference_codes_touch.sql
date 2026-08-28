create or replace function public.tg_reference_codes_touch()
  returns trigger
  language plpgsql
  AS $function$
begin
  new.updated_at := now();
  return new;
end $function$;

grant execute on function "public"."tg_reference_codes_touch"() to public, "anon", "authenticated", "postgres", "service_role";
