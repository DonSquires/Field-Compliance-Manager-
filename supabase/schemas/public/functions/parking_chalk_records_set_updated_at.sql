create or replace function public.parking_chalk_records_set_updated_at()
  returns trigger
  language plpgsql
  AS $function$
begin
  new.updated_at := now();
  return new;
end;
$function$;

grant execute on function "public"."parking_chalk_records_set_updated_at"() to public, "anon", "authenticated", "postgres", "service_role";
