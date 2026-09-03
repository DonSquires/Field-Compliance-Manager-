-- ============================================================
-- Migration 20260903160000 — Unified Evidence Media Spine & Court-Ready Lock
-- ============================================================
-- Issue #101: Unified court-ready evidence registration, SHA-256 integrity hash,
-- retention calculation, immutable evidence locking, and audit provenance.

-- 1. Add court-ready integrity & retention columns to evidence_items
alter table public.evidence_items
  add column if not exists sha256_hash text,
  add column if not exists retention_days integer,
  add column if not exists is_court_ready boolean not null default false,
  add column if not exists locked_at timestamptz;

comment on column public.evidence_items.sha256_hash is
  'SHA-256 cryptographic digest of the raw evidence payload for court-ready integrity verification.';

comment on column public.evidence_items.retention_days is
  'Calculated retention window in days derived from retention_policies or module defaults.';

comment on column public.evidence_items.is_court_ready is
  'Whether this evidence item meets court-ready chain-of-custody standards (watermarked, hashed, time-stamped).';

comment on column public.evidence_items.locked_at is
  'Timestamp when the evidence record was sealed. Sealed records cannot be modified or purged before retention expiration.';

-- 2. Revoke direct inserts & updates on evidence_items
revoke insert, update, delete on table public.evidence_items from authenticated, anon;

-- 3. Governed evidence registration RPC
create or replace function public.register_evidence_media_item(
  p_module_key text,
  p_evidence_kind text,
  p_storage_path text,
  p_sha256_hash text DEFAULT NULL,
  p_is_court_ready boolean DEFAULT false,
  p_retention_days integer DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb
) returns table (
  id uuid,
  organization_id uuid,
  module_key text,
  evidence_kind text,
  storage_path text,
  sha256_hash text,
  is_court_ready boolean,
  retention_days integer,
  captured_at timestamptz
) language plpgsql security definer set search_path = public as $$
declare
  v_user_id uuid := auth.uid();
  v_org_id uuid;
  v_item public.evidence_items%rowtype;
  v_retention integer := p_retention_days;
  v_clean_path text := nullif(trim(coalesce(p_storage_path, '')), '');
begin
  if v_user_id is null then raise exception 'Authentication required'; end if;
  select p.organization_id into v_org_id from public.user_profiles p where p.id = v_user_id and p.deactivated_at is null;
  if v_org_id is null then raise exception 'Active profile required for evidence registration'; end if;

  if nullif(trim(coalesce(p_module_key, '')), '') is null then
    raise exception 'module_key is required';
  end if;

  if p_evidence_kind not in ('photo', 'video', 'audio', 'document', 'note') then
    raise exception 'Unsupported evidence kind %', p_evidence_kind;
  end if;

  if v_clean_path is null then
    raise exception 'storage_path is required';
  end if;

  -- Derive retention_days from retention_policies if not explicitly provided
  if v_retention is null then
    select r.retention_days into v_retention
    from public.retention_policies r
    where (r.organization_id = v_org_id or r.organization_id is null)
      and (r.module_key = p_module_key or r.module_key is null)
      and r.is_active = true
    order by r.organization_id nulls last, r.module_key nulls last
    limit 1;
    if v_retention is null then v_retention := 2555; end if; -- Default 7 years (2555 days)
  end if;

  insert into public.evidence_items (
    organization_id, module_key, evidence_kind, storage_path, captured_by_user_id,
    captured_at, sha256_hash, is_court_ready, retention_days, metadata
  ) values (
    v_org_id, p_module_key, p_evidence_kind, v_clean_path, v_user_id,
    clock_timestamp(), nullif(trim(coalesce(p_sha256_hash, '')), ''), coalesce(p_is_court_ready, false), v_retention, coalesce(p_metadata, '{}'::jsonb)
  ) returning * into v_item;

  insert into public.audit_log (
    organization_id, actor_user_id, action, target_table, target_id, metadata
  ) values (
    v_org_id, v_user_id, 'evidence_media_registered', 'evidence_items', v_item.id,
    jsonb_build_object(
      'module_key', v_item.module_key,
      'evidence_kind', v_item.evidence_kind,
      'storage_path', v_item.storage_path,
      'sha256_hash', v_item.sha256_hash,
      'is_court_ready', v_item.is_court_ready,
      'retention_days', v_item.retention_days
    )
  );

  return query select v_item.id, v_item.organization_id, v_item.module_key, v_item.evidence_kind, v_item.storage_path, v_item.sha256_hash, v_item.is_court_ready, v_item.retention_days, v_item.captured_at;
end;
$$;

revoke all on function public.register_evidence_media_item from public, anon;
grant execute on function public.register_evidence_media_item to authenticated, service_role;

-- 4. Governed court-ready evidence sealing RPC
create or replace function public.seal_court_ready_evidence(
  p_evidence_id uuid,
  p_sha256_hash text,
  p_notes text DEFAULT NULL
) returns table (
  evidence_id uuid,
  sha256_hash text,
  is_court_ready boolean,
  locked_at timestamptz
) language plpgsql security definer set search_path = public as $$
declare
  v_user_id uuid := auth.uid();
  v_item public.evidence_items%rowtype;
  v_hash text := nullif(trim(coalesce(p_sha256_hash, '')), '');
begin
  if v_user_id is null then raise exception 'Authentication required'; end if;
  if v_hash is null then raise exception 'sha256_hash is required to seal court-ready evidence'; end if;

  select e.* into v_item from public.evidence_items e where e.id = p_evidence_id for update;
  if not found then raise exception 'Evidence item not found'; end if;
  if not public.is_admin_for_org(v_item.organization_id) and v_item.captured_by_user_id <> v_user_id then
    raise exception 'Not authorised to seal this evidence item';
  end if;

  if v_item.locked_at is not null then
    raise exception 'Evidence item is already sealed and locked';
  end if;

  update public.evidence_items
    set sha256_hash = v_hash,
        is_court_ready = true,
        locked_at = clock_timestamp(),
        metadata = metadata || jsonb_build_object('seal_notes', nullif(trim(coalesce(p_notes, '')), ''), 'sealed_by', v_user_id)
    where id = v_item.id
    returning * into v_item;

  insert into public.audit_log (
    organization_id, actor_user_id, action, target_table, target_id, metadata
  ) values (
    v_item.organization_id, v_user_id, 'evidence_media_sealed', 'evidence_items', v_item.id,
    jsonb_build_object('sha256_hash', v_hash, 'locked_at', v_item.locked_at, 'notes', p_notes)
  );

  return query select v_item.id, v_item.sha256_hash, v_item.is_court_ready, v_item.locked_at;
end;
$$;

revoke all on function public.seal_court_ready_evidence from public, anon;
grant execute on function public.seal_court_ready_evidence to authenticated, service_role;
