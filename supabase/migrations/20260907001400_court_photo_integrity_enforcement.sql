-- Court-grade photo evidence must retain raw and rendered hashes, inference
-- watermark provenance, and be sealed when it enters the evidence spine.

create or replace function public.tg_seal_verified_photo_evidence()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_raw_hash text := new.metadata->>'raw_sha256';
  v_watermarked_hash text := new.metadata->>'watermarked_sha256';
begin
  if new.evidence_kind <> 'photo' then
    return new;
  end if;

  if coalesce(new.metadata->>'watermark_text', '') = ''
    or coalesce(new.metadata->>'watermark_service', '') <> 'inference'
    or v_raw_hash !~ '^[0-9a-f]{64}$'
    or v_watermarked_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Court photo evidence requires inference watermark provenance and SHA-256 hashes';
  end if;

  new.sha256_hash := v_watermarked_hash;
  new.is_court_ready := true;
  new.locked_at := coalesce(new.locked_at, clock_timestamp());
  return new;
end;
$$;

drop trigger if exists trg_seal_verified_photo_evidence on public.evidence_items;
create trigger trg_seal_verified_photo_evidence
before insert or update on public.evidence_items
for each row execute function public.tg_seal_verified_photo_evidence();

create or replace function public.register_edge_court_photo(
  p_organization_id uuid,
  p_module_key text,
  p_storage_path text,
  p_captured_at timestamptz,
  p_metadata jsonb
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_evidence_id uuid;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Only trusted evidence-processing services may register edge photos';
  end if;

  insert into public.evidence_items (
    organization_id, module_key, evidence_kind, storage_path, captured_at,
    retention_days, metadata
  ) values (
    p_organization_id, p_module_key, 'photo', p_storage_path, p_captured_at,
    2555, p_metadata
  ) returning id into v_evidence_id;

  insert into public.audit_log (organization_id, action, target_table, target_id, metadata)
  values (p_organization_id, 'edge_court_photo_registered', 'evidence_items', v_evidence_id, p_metadata);

  return v_evidence_id;
end;
$$;

revoke all on function public.register_edge_court_photo(uuid, text, text, timestamptz, jsonb) from public, anon, authenticated;
grant execute on function public.register_edge_court_photo(uuid, text, text, timestamptz, jsonb) to service_role;