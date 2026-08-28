create or replace function public.generate_parking_notice_number (
  p_org_id uuid
)
  returns text
  language plpgsql
  security definer
  set search_path to 'public'
  AS $function$
declare
  v_org_code text;
  v_date text;
  v_seq integer;
  v_notice_number text;
begin
  select coalesce(upper(left(replace(name, ' ', ''), 4)), 'PARK')
  into v_org_code
  from organizations where id = p_org_id;

  v_date := to_char(current_date, 'YYYYMMDD');

  select coalesce(max(
    cast(right(notice_number, 4) as integer)
  ), 0) + 1
  into v_seq
  from parking_infringement_notices
  where organization_id = p_org_id
    and notice_number like 'PARK-' || v_org_code || '-' || v_date || '-%';

  v_notice_number := 'PARK-' || v_org_code || '-' || v_date || '-' || lpad(v_seq::text, 4, '0');
  return v_notice_number;
end;
$function$;

grant execute on function "public"."generate_parking_notice_number"(uuid) to public, "anon", "authenticated", "postgres", "service_role";
