create or replace function public.promote_document_to_reference_library (
  p_document_version_id uuid,
  p_target_scope        text,
  p_approver_id         uuid,
  p_metadata            jsonb default '{}'::jsonb
)
  returns jsonb
  language plpgsql
  security definer
  set search_path to 'public'
  AS $function$
declare
  v_doc_id uuid;
  v_org_id uuid;
  v_class record;
  v_title text := nullif(btrim(coalesce(p_metadata->>'title', '')), '');
  v_publisher text := nullif(btrim(coalesce(p_metadata->>'publisher', '')), '');
  v_doc_type text := nullif(btrim(coalesce(p_metadata->>'document_type', '')), '');
  v_effective text := coalesce(p_metadata->>'effective_from', p_metadata->>'version_label');
  v_is_global boolean := (p_target_scope = 'global_reference');
  v_entry_id uuid;
begin
  if p_target_scope not in ('global_reference','tenant_reference') then
    return jsonb_build_object('ok', false, 'error', 'target_scope must be global_reference or tenant_reference');
  end if;

  select dv.document_id, d.organization_id
  into v_doc_id, v_org_id
  from public.document_versions dv
  join public.documents d on d.id = dv.document_id
  where dv.id = p_document_version_id;

  if v_doc_id is null then
    return jsonb_build_object('ok', false, 'error', 'document_version not found');
  end if;

  -- Latest classification is required before any promotion.
  select * into v_class
  from public.document_classifications
  where document_version_id = p_document_version_id
  order by created_at desc
  limit 1;

  if v_class is null then
    return jsonb_build_object('ok', false, 'error', 'document must be classified before promotion');
  end if;

  -- HARD routing rules for global promotion.
  if v_is_global then
    if v_class.privacy_class not in ('public','internal_non_sensitive') then
      return jsonb_build_object('ok', false, 'error',
        format('privacy_class %s is not eligible for global reference; tenant-scope only', v_class.privacy_class));
    end if;
    if v_class.contains_pii or v_class.contains_financial_data or v_class.contains_legal_privilege then
      return jsonb_build_object('ok', false, 'error', 'document flagged PII/financial/legal-privilege; global promotion blocked');
    end if;
    -- Require human review OR confident, unambiguous classification.
    if v_class.classifier_source <> 'human_review'
       and coalesce(v_class.confidence, 0) < 0.85 then
      return jsonb_build_object('ok', false, 'error', 'low-confidence classification requires human review before global promotion');
    end if;
    -- Provenance floor for durable global references.
    if v_title is null or v_publisher is null or v_doc_type is null or v_effective is null then
      return jsonb_build_object('ok', false, 'error', 'global promotion requires title, publisher, document_type and effective date/version');
    end if;
  end if;

  -- Physical bytes stay put; routing is logical (update scope + catalogue).
  update public.documents
  set current_scope = case when v_is_global then 'global_reference' else 'tenant' end
  where id = v_doc_id;

  insert into public.reference_catalog_entries (
    document_version_id, organization_id, title, topic, publisher, jurisdiction,
    document_type, trust_level, searchable_tags, is_global_reference,
    approval_status, approved_by, approved_at
  ) values (
    p_document_version_id,
    case when v_is_global then null else v_org_id end,
    coalesce(v_title, 'Untitled document'),
    p_metadata->>'topic',
    v_publisher,
    p_metadata->>'jurisdiction',
    v_doc_type,
    coalesce(nullif(p_metadata->>'trust_level',''), 'provisional'),
    coalesce((select array_agg(value::text) from jsonb_array_elements_text(coalesce(p_metadata->'searchable_tags','[]'::jsonb))), '{}'),
    v_is_global,
    'approved',
    p_approver_id,
    now()
  )
  returning id into v_entry_id;

  return jsonb_build_object(
    'ok', true,
    'catalog_entry_id', v_entry_id,
    'target_scope', p_target_scope,
    'is_global_reference', v_is_global,
    'privacy_class', v_class.privacy_class
  );
exception when others then
  return jsonb_build_object('ok', false, 'error', sqlerrm);
end;
$function$;

grant execute on function "public"."promote_document_to_reference_library"(uuid, text, uuid, jsonb) to "anon", "postgres", "service_role";

comment on function "public"."promote_document_to_reference_library"(uuid, text, uuid, jsonb) is 'Governed promotion of a classified document version to the tenant or global reference library. Hard-rejects global promotion of tenant_sensitive/restricted, PII/financial/legal-privilege, low-confidence/unreviewed, or under-provenanced material. service_role execute only; the edge function verifies the approver is admin/GM first.';

revoke all on function "public"."promote_document_to_reference_library"(uuid, text, uuid, jsonb) from public;
