create or replace function public.notify_roster_assignment_created()
  returns trigger
  language plpgsql
  security definer
  set search_path to 'public'
  AS $function$
begin
  perform public.enqueue_notification(
    p_organization_id  => new.organization_id,
    p_category         => 'roster',
    p_title            => 'New roster assignment',
    p_body             => coalesce(new.shift, 'Shift') || ' assignment has been added for you.',
    p_severity         => 'info',
    p_recipient_user_id=> new.officer_id,
    p_recipient_role   => null,
    p_link_page        => 'roster',
    p_link_payload     => jsonb_build_object('assignment_id', new.id),
    p_dedup_key        => 'roster_assignment:' || new.id::text
  );

  return new;
end;
$function$;

grant execute on function "public"."notify_roster_assignment_created"() to public, "anon", "authenticated", "postgres", "service_role";
