create or replace function public.bob_search_reference_documents (
  p_query            text    default null::text,
  p_scope            text    default 'both'::text,
  p_organization_id  uuid    default null::uuid,
  p_document_type    text    default null::text,
  p_jurisdiction     text    default null::text,
  p_tags             text[]  default null::text[],
  p_allow_restricted boolean default false,
  p_limit            integer default 25
)
  returns jsonb
  language plpgsql
  security definer
  set search_path to 'public'
  AS $function$
declare
  v_limit int := greatest(1, least(coalesce(p_limit, 25), 100));
  v_scope text := lower(coalesce(p_scope, 'both'));
  v_q text := nullif(btrim(coalesce(p_query, '')), '');
  result jsonb;
begin
  if v_scope not in ('tenant','global','both') then
    return jsonb_build_object('ok', false, 'error', 'scope must be tenant, global or both');
  end if;

  select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb)
  into result
  from (
    select
      rce.id                as catalog_entry_id,
      rce.title,
      rce.topic,
      rce.publisher,
      rce.jurisdiction,
      rce.document_type,
      rce.trust_level,
      rce.searchable_tags,
      rce.is_global_reference,
      rce.organization_id,
      d.id                  as document_id,
      dv.id                 as document_version_id,
      dv.version_label,
      dv.effective_from,
      dv.effective_to,
      dc.privacy_class,
      dc.confidence         as classification_confidence,
      -- Approved retrieval handle only. Never a raw bucket path.
      ('docref:' || dv.id::text) as retrieval_handle
    from public.reference_catalog_entries rce
    join public.document_versions dv on dv.id = rce.document_version_id
    join public.documents d on d.id = dv.document_id
    left join lateral (
      select privacy_class, confidence
      from public.document_classifications c
      where c.document_version_id = dv.id
      order by c.created_at desc
      limit 1
    ) dc on true
    where rce.approval_status = 'approved'
      and d.current_scope <> 'quarantined'
      -- Scope filter
      and (
        (v_scope = 'global' and rce.is_global_reference)
        or (v_scope = 'tenant' and rce.organization_id is not distinct from p_organization_id and not rce.is_global_reference)
        or (v_scope = 'both' and (rce.is_global_reference
              or rce.organization_id is not distinct from p_organization_id))
      )
      -- Restricted / tenant_sensitive never surface unless explicitly authorized.
      and (
        p_allow_restricted
        or coalesce(dc.privacy_class, 'restricted') in ('public','internal_non_sensitive')
        or (rce.organization_id is not distinct from p_organization_id
            and coalesce(dc.privacy_class, 'restricted') = 'tenant_sensitive')
      )
      and (p_document_type is null or rce.document_type = p_document_type)
      and (p_jurisdiction is null or rce.jurisdiction = p_jurisdiction)
      and (p_tags is null or rce.searchable_tags && p_tags)
      and (
        v_q is null
        or rce.title ilike '%' || v_q || '%'
        or coalesce(rce.topic, '') ilike '%' || v_q || '%'
        or coalesce(dv.extracted_text, '') ilike '%' || v_q || '%'
      )
    order by rce.trust_level desc, rce.updated_at desc
    limit v_limit
  ) t;

  return jsonb_build_object('ok', true, 'results', coalesce(result, '[]'::jsonb), 'scope', v_scope, 'limit', v_limit);
exception when others then
  return jsonb_build_object('ok', false, 'error', sqlerrm);
end;
$function$;

grant execute on function "public"."bob_search_reference_documents"(text, text, uuid, text, text, text[], boolean, integer) to "anon", "postgres", "service_role";

comment on function "public"."bob_search_reference_documents"(text, text, uuid, text, text, text[], boolean, integer) is 'Mediated, policy-filtered retrieval over approved reference documents for Bob. Enforces tenant/global scope, excludes quarantined and (unless authorized) restricted/tenant_sensitive material, and returns summaries + approved retrieval handles only. service_role execute only; the edge function verifies caller scope first.';

revoke all on function "public"."bob_search_reference_documents"(text, text, uuid, text, text, text[], boolean, integer) from public;
