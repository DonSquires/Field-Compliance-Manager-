create or replace function public.validate_dispatch_job_service_agreement()
  returns trigger
  language plpgsql
  security definer
  set search_path to 'public'
  AS $function$
declare
  v_site_agreement_id uuid;
begin
  if new.client_site_id is null then
    return new;
  end if;

  select cs.service_agreement_id
    into v_site_agreement_id
  from public.client_sites cs
  where cs.id = new.client_site_id;

  if v_site_agreement_id is not null then
    if new.service_agreement_id is null then
      new.service_agreement_id := v_site_agreement_id;
    elsif new.service_agreement_id <> v_site_agreement_id then
      raise exception
        'dispatch_jobs.service_agreement_id (%) must match client_sites.service_agreement_id (%) for client_site_id (%)',
        new.service_agreement_id, v_site_agreement_id, new.client_site_id;
    end if;
  end if;

  return new;
end;
$function$;

grant execute on function "public"."validate_dispatch_job_service_agreement"() to public, "anon", "authenticated", "postgres", "service_role";
