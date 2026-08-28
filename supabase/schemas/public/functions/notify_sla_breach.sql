create or replace function public.notify_sla_breach()
  returns trigger
  language plpgsql
  security definer
  set search_path to 'public'
  AS $function$
begin
  if new.status = 'breached' and coalesce(old.status, '') is distinct from 'breached' then
    perform enqueue_notification(
      p_organization_id   => new.organization_id,
      p_category          => 'sla_breach',
      p_title             => 'SLA breached',
      p_body              => 'An SLA clock has breached its target'
                             || case when new.target_minutes is not null
                                  then ' (' || coalesce(new.elapsed_minutes, 0) || ' min vs ' || new.target_minutes || ' min target)'
                                  else '' end || '.',
      p_severity          => 'critical',
      p_recipient_user_id => null,
      p_recipient_role    => 'admin',
      p_link_page         => 'obligations',
      p_link_payload      => jsonb_build_object(
                               'sla_clock_id', new.id,
                               'dispatch_job_id', new.dispatch_job_id,
                               'site_id', new.site_id,
                               'obligation_id', new.obligation_id
                             ),
      p_dedup_key         => 'sla:' || new.id::text
    );
  end if;
  return new;
end;
$function$;

grant execute on function "public"."notify_sla_breach"() to public, "anon", "authenticated", "postgres", "service_role";

comment on function "public"."notify_sla_breach"() is 'Layer 4.4 producer: enqueues a critical sla_breach notification (role=admin) once per clock when status becomes breached.';
