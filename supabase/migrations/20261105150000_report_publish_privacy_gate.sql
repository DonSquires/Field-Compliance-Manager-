-- Publishing a monthly report pack makes it client-readable on the portal, so
-- the privacy clearance the PDF and email already require is now enforced in
-- the publication transaction itself: a direct RPC call or an older client
-- cannot publish wording or entries Bob's privacy oracle has not cleared.

CREATE OR REPLACE FUNCTION "public"."review_monthly_report_pack"(p_pack_id uuid, p_expected_updated_at timestamp with time zone, p_title text DEFAULT NULL::text, p_executive_summary text DEFAULT NULL::text, p_client_notes text DEFAULT NULL::text, p_follow_up text DEFAULT NULL::text, p_action text DEFAULT 'save'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_pack record;
  v_editorial jsonb;
  v_client_has_login boolean := false;
  v_delivery_channel text;
  v_updated public.monthly_report_packs%rowtype;
  v_cleared jsonb;
  v_pending integer;
begin
  if v_actor is null then
    raise exception 'Authenticated provider administrator required';
  end if;
  if p_action not in ('save', 'publish') then
    raise exception 'Action must be save or publish';
  end if;
  if p_expected_updated_at is null then
    raise exception 'Expected updated timestamp is required';
  end if;
  if length(coalesce(p_title, '')) > 160
     or length(coalesce(p_executive_summary, '')) > 4000
     or length(coalesce(p_client_notes, '')) > 8000
     or length(coalesce(p_follow_up, '')) > 4000 then
    raise exception 'Report review content exceeds the allowed length';
  end if;

  select pack.*, agreement.client_organization_id,
         agreement.client_portal_reports_enabled
  into v_pack
  from public.monthly_report_packs pack
  join public.service_agreements agreement
    on agreement.id = pack.service_agreement_id
  where pack.id = p_pack_id
  for update of pack;

  if v_pack.id is null then
    raise exception 'Report pack not found';
  end if;
  if not public.is_admin_for_org(v_pack.organization_id) then
    raise exception 'Provider administrator access required';
  end if;
  if v_pack.status = 'sent' then
    raise exception 'Sent report packs are immutable';
  end if;
  if v_pack.updated_at is distinct from p_expected_updated_at then
    raise exception 'Report pack changed since it was opened; reload before saving';
  end if;

  v_editorial := jsonb_strip_nulls(jsonb_build_object(
    'title', nullif(btrim(coalesce(p_title, '')), ''),
    'executive_summary', nullif(btrim(coalesce(p_executive_summary, '')), ''),
    'client_notes', nullif(btrim(coalesce(p_client_notes, '')), ''),
    'follow_up', nullif(btrim(coalesce(p_follow_up, '')), '')
  ));

  if p_action = 'publish' and not (v_editorial ? 'title') then
    raise exception 'A client-facing report title is required before publishing';
  end if;

  -- Publishing makes the pack client-readable, so a monthly pack with a frozen
  -- activity copy must carry Bob's privacy clearance for every entry and for
  -- this exact wording (written by the check-report-privacy edge function).
  if p_action = 'publish'
     and coalesce(v_pack.report_kind, 'monthly') <> 'custom'
     and jsonb_typeof(v_pack.activity_lines) = 'object'
     and jsonb_typeof(v_pack.activity_lines -> 'lines') = 'array' then
    select count(*)::integer
    into v_pending
    from jsonb_array_elements(v_pack.activity_lines -> 'lines') line
    where (line -> 'pv') is distinct from to_jsonb(1)
      and exists (
        select 1
        from unnest(array['ti', 'n', 'ac']) field
        where jsonb_typeof(line -> field) = 'string'
          and (line ->> field) ~ '\S'
      );
    if v_pending > 0 then
      raise exception 'Run Bob''s privacy check first: % report entries have not been checked for personal names', v_pending
        using errcode = 'P0001';
    end if;

    v_cleared := v_pack.activity_lines -> 'privacy' -> 'cleared_editorial';
    if jsonb_typeof(v_cleared) is distinct from 'object'
       or exists (
         select 1
         from (values
           ('title', p_title),
           ('executive_summary', p_executive_summary),
           ('client_notes', p_client_notes),
           ('follow_up', p_follow_up)
         ) submitted(field, value)
         where regexp_replace(coalesce(submitted.value, ''), '^\s+|\s+$', '', 'g')
               is distinct from coalesce(v_cleared ->> submitted.field, '')
       ) then
      raise exception 'Run Bob''s privacy check first: the report wording has changed since it was last checked for personal names'
        using errcode = 'P0001';
    end if;
  end if;

  select exists (
    select 1
    from public.user_profiles profile
    where profile.organization_id = v_pack.client_organization_id
      and profile.deactivated_at is null
      and profile.role in ('client_admin', 'client_officer', 'client_viewer')
  )
  into v_client_has_login;

  if p_action = 'publish' then
    v_delivery_channel := case
      when v_pack.client_portal_reports_enabled and v_client_has_login then 'portal'
      else 'email'
    end;
  end if;

  update public.monthly_report_packs
  set editorial = v_editorial,
      status = case when p_action = 'publish' then 'generated' else 'draft' end,
      reviewed_at = clock_timestamp(),
      reviewed_by = v_actor,
      published_at = case when p_action = 'publish' then clock_timestamp() else null end,
      published_by = case when p_action = 'publish' then v_actor else null end,
      delivery_channel = v_delivery_channel,
      pdf_path = null,
      pdf_mime_type = null,
      pdf_sha256 = null,
      pdf_renderer_version = null,
      delivery_error = null,
      updated_at = clock_timestamp()
  where id = p_pack_id
    and updated_at = p_expected_updated_at
  returning * into v_updated;

  if v_updated.id is null then
    raise exception 'Report pack changed since it was opened; reload before saving';
  end if;

  insert into public.audit_log (
    organization_id, actor_user_id, action, target_table, target_id, metadata
  ) values (
    v_updated.organization_id,
    v_actor,
    case when p_action = 'publish'
      then 'monthly_report_pack_published'
      else 'monthly_report_pack_review_saved'
    end,
    'monthly_report_packs',
    v_updated.id,
    jsonb_build_object(
      'status', v_updated.status,
      'delivery_channel', v_updated.delivery_channel,
      'client_has_login', v_client_has_login,
      'editorial_fields', array(select jsonb_object_keys(v_editorial))
    )
  );

  return jsonb_build_object(
    'id', v_updated.id,
    'status', v_updated.status,
    'editorial', v_updated.editorial,
    'updated_at', v_updated.updated_at,
    'reviewed_at', v_updated.reviewed_at,
    'published_at', v_updated.published_at,
    'delivery_channel', v_updated.delivery_channel,
    'client_has_login', v_client_has_login
  );
end;
$function$;

COMMENT ON FUNCTION public.review_monthly_report_pack(uuid, timestamp with time zone, text, text, text, text, text) IS 'Saves or publishes provider-authored report editorial content with optimistic locking and audit evidence. Publishing a monthly pack requires Bob''s privacy clearance for every entry and the exact wording. Source-derived metrics are not editable; sent packs are immutable.';
REVOKE ALL ON FUNCTION public.review_monthly_report_pack(uuid, timestamp with time zone, text, text, text, text, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.review_monthly_report_pack(uuid, timestamp with time zone, text, text, text, text, text) TO authenticated;
