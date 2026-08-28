create or replace function public.enqueue_notification (
  p_organization_id   uuid,
  p_category          text,
  p_title             text,
  p_body              text  default null::text,
  p_severity          text  default 'info'::text,
  p_recipient_user_id uuid  default null::uuid,
  p_recipient_role    text  default null::text,
  p_link_page         text  default null::text,
  p_link_payload      jsonb default null::jsonb,
  p_dedup_key         text  default null::text
)
  returns uuid
  language plpgsql
  security definer
  set search_path to 'public'
  AS $function$
declare
  v_id uuid;
begin
  if p_recipient_user_id is null and p_recipient_role is null then
    raise exception 'enqueue_notification requires a recipient_user_id or recipient_role';
  end if;

  -- Idempotent on dedup_key within the org.
  if p_dedup_key is not null then
    select id into v_id
    from notifications
    where organization_id = p_organization_id and dedup_key = p_dedup_key
    limit 1;
    if v_id is not null then
      return v_id;
    end if;
  end if;

  insert into notifications (
    organization_id, recipient_user_id, recipient_role, category, severity,
    title, body, link_page, link_payload, dedup_key
  ) values (
    p_organization_id, p_recipient_user_id, p_recipient_role, p_category, coalesce(p_severity, 'info'),
    p_title, p_body, p_link_page, p_link_payload, p_dedup_key
  )
  returning id into v_id;

  return v_id;
end;
$function$;

grant execute
  on function "public"."enqueue_notification"(uuid, text, text, text, text, uuid, text, text, jsonb, text)
  to public, "anon", "authenticated", "postgres", "service_role";

comment on function "public"."enqueue_notification"(uuid, text, text, text, text, uuid, text, text, jsonb, text) is 'Layer 4.4 single write path for notifications. Idempotent on (organization_id, dedup_key). SECURITY DEFINER so triggers/edge fns can enqueue.';
