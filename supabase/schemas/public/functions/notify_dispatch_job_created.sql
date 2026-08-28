create or replace function public.notify_dispatch_job_created()
  returns trigger
  language plpgsql
  security definer
  set search_path to 'public'
  AS $function$
begin
  if new.status in ('pending', 'dispatched') then
    perform public.enqueue_notification(
      p_organization_id   => new.organization_id,
      p_category          => 'dispatch',
      p_title             => 'New dispatch job',
      p_body              => 'A new dispatch job is available.',
      p_severity          => case when new.priority in ('critical', 'high') then 'warning' else 'info' end,
      p_recipient_user_id => null,
      p_recipient_role    => 'officer',
      p_link_page         => 'open-jobs',
      p_link_payload      => jsonb_build_object('dispatch_job_id', new.id),
      p_dedup_key         => 'dispatch_job_open:' || new.id::text
    );
  end if;

  return new;
end;
$function$;

grant execute on function "public"."notify_dispatch_job_created"() to public, "anon", "authenticated", "postgres", "service_role";
