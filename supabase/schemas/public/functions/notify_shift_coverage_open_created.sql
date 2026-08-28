create or replace function public.notify_shift_coverage_open_created()
  returns trigger
  language plpgsql
  security definer
  set search_path to 'public'
  AS $function$
begin
  if new.status = 'open' then
    perform public.enqueue_notification(
      p_organization_id   => new.organization_id,
      p_category          => 'open_job',
      p_title             => 'Open shift available',
      p_body              => 'A new open shift is available to claim.',
      p_severity          => case when new.urgency = 'urgent' then 'warning' else 'info' end,
      p_recipient_user_id => null,
      p_recipient_role    => 'officer',
      p_link_page         => 'open-jobs',
      p_link_payload      => jsonb_build_object('coverage_request_id', new.id),
      p_dedup_key         => 'shift_coverage_open:' || new.id::text
    );
  end if;

  return new;
end;
$function$;

grant execute on function "public"."notify_shift_coverage_open_created"() to public, "anon", "authenticated", "postgres", "service_role";
