create or replace function public.generate_noise_job_number()
  returns text
  language sql
  AS $function$
  select 'NC-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('noise_job_seq')::text, 6, '0');
$function$;

grant execute on function "public"."generate_noise_job_number"() to public, "anon", "authenticated", "postgres", "service_role";
