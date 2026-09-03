-- ============================================================
-- Migration 20260903130000 — Officer Device Tokens & Push Delivery Spine
-- ============================================================
-- Issue #98: Idempotent officer device token registration, platform validation,
-- push notification queueing, and audit provenance.

create table if not exists public.officer_device_tokens (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references public.user_profiles(id) on delete cascade,
  push_token text not null,
  platform text not null default 'expo',
  device_name text,
  app_version text,
  is_active boolean not null default true,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_officer_device_token unique (organization_id, user_id, push_token),
  constraint officer_device_tokens_platform_check check (platform in ('expo', 'ios', 'android', 'web'))
);

comment on table public.officer_device_tokens is
  'Registered push notification device tokens for active officers and administrators.';

alter table public.officer_device_tokens enable row level security;

create policy odt_select on public.officer_device_tokens
  for select using (public.org_access_allowed(organization_id));

revoke insert, update, delete on table public.officer_device_tokens from authenticated, anon;

create or replace function public.register_officer_device_token(
  p_push_token text,
  p_platform text DEFAULT 'expo',
  p_device_name text DEFAULT NULL,
  p_app_version text DEFAULT NULL
) returns table (
  id uuid,
  push_token text,
  platform text,
  is_active boolean,
  last_seen_at timestamptz
) language plpgsql security definer set search_path = public as $$
declare
  v_user_id uuid := auth.uid();
  v_org_id uuid;
  v_token public.officer_device_tokens%rowtype;
  v_clean_token text := trim(coalesce(p_push_token, ''));
  v_clean_platform text := lower(trim(coalesce(p_platform, 'expo')));
begin
  if v_user_id is null then raise exception 'Authentication required'; end if;
  select p.organization_id into v_org_id from public.user_profiles p where p.id = v_user_id and p.deactivated_at is null;
  if v_org_id is null then raise exception 'Active profile required for device registration'; end if;
  if v_clean_token = '' then raise exception 'push_token is required'; end if;
  if v_clean_platform not in ('expo', 'ios', 'android', 'web') then
    raise exception 'Unsupported device platform %', p_platform;
  end if;

  insert into public.officer_device_tokens (
    organization_id, user_id, push_token, platform, device_name, app_version, is_active, last_seen_at, updated_at
  ) values (
    v_org_id, v_user_id, v_clean_token, v_clean_platform, nullif(trim(coalesce(p_device_name, '')), ''), nullif(trim(coalesce(p_app_version, '')), ''), true, clock_timestamp(), clock_timestamp()
  )
  on conflict (organization_id, user_id, push_token) do update set
    platform = excluded.platform,
    device_name = coalesce(excluded.device_name, officer_device_tokens.device_name),
    app_version = coalesce(excluded.app_version, officer_device_tokens.app_version),
    is_active = true,
    last_seen_at = clock_timestamp(),
    updated_at = clock_timestamp()
  returning * into v_token;

  insert into public.audit_log (
    organization_id, actor_user_id, action, target_table, target_id, metadata
  ) values (
    v_org_id, v_user_id, 'officer_device_token_registered', 'officer_device_tokens', v_token.id,
    jsonb_build_object('platform', v_token.platform, 'device_name', v_token.device_name, 'app_version', v_token.app_version)
  );

  return query select v_token.id, v_token.push_token, v_token.platform, v_token.is_active, v_token.last_seen_at;
end;
$$;

revoke all on function public.register_officer_device_token from public, anon;
grant execute on function public.register_officer_device_token to authenticated, service_role;

create or replace function public.unregister_officer_device_token(
  p_push_token text
) returns boolean language plpgsql security definer set search_path = public as $$
declare
  v_user_id uuid := auth.uid();
  v_clean_token text := trim(coalesce(p_push_token, ''));
  v_count integer;
  v_org_id uuid;
begin
  if v_user_id is null then raise exception 'Authentication required'; end if;
  select p.organization_id into v_org_id from public.user_profiles p where p.id = v_user_id;

  update public.officer_device_tokens
    set is_active = false, updated_at = clock_timestamp()
    where user_id = v_user_id and push_token = v_clean_token;
  get diagnostics v_count = row_count;

  if v_count > 0 and v_org_id is not null then
    insert into public.audit_log (
      organization_id, actor_user_id, action, target_table, target_id, metadata
    ) values (
      v_org_id, v_user_id, 'officer_device_token_unregistered', 'officer_device_tokens', v_user_id,
      jsonb_build_object('push_token', v_clean_token)
    );
  end if;

  return v_count > 0;
end;
$$;

revoke all on function public.unregister_officer_device_token from public, anon;
grant execute on function public.unregister_officer_device_token to authenticated, service_role;
