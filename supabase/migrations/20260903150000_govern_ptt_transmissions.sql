-- ============================================================
-- Migration 20260903150000 — Governed PTT Transmissions & Radio Transcripts
-- ============================================================
-- Issue #100: Governed RPCs for opening, updating, closing, and transcribing
-- PTT radio transmissions with audit provenance and RLS security.

-- 1. Revoke direct inserts from authenticated / anon (require RPC or service role)
revoke insert, update on table public.ptt_transmissions from authenticated, anon;
revoke insert, update on table public.radio_transcript_segments from authenticated, anon;

-- 2. Open PTT transmission RPC
create or replace function public.open_ptt_transmission(
  p_channel_id uuid DEFAULT NULL,
  p_emergency boolean DEFAULT false,
  p_metadata jsonb DEFAULT '{}'::jsonb
) returns table (
  transmission_id uuid,
  organization_id uuid,
  state text,
  started_at timestamptz
) language plpgsql security definer set search_path = public as $$
declare
  v_user_id uuid := auth.uid();
  v_org_id uuid;
  v_trans public.ptt_transmissions%rowtype;
begin
  if v_user_id is null then raise exception 'Authentication required'; end if;
  select p.organization_id into v_org_id from public.user_profiles p where p.id = v_user_id and p.deactivated_at is null;
  if v_org_id is null then raise exception 'Active officer profile required for PTT transmission'; end if;

  if p_channel_id is not null and not exists (select 1 from public.ptt_channels c where c.id = p_channel_id and c.organization_id = v_org_id) then
    raise exception 'Channel does not belong to the officer organisation';
  end if;

  insert into public.ptt_transmissions (
    organization_id, channel_id, speaker_user_id, state, emergency, metadata
  ) values (
    v_org_id, p_channel_id, v_user_id, case when p_emergency then 'emergency' else 'started' end, coalesce(p_emergency, false), coalesce(p_metadata, '{}'::jsonb)
  ) returning * into v_trans;

  insert into public.audit_log (
    organization_id, actor_user_id, action, target_table, target_id, metadata
  ) values (
    v_org_id, v_user_id, 'ptt_transmission_started', 'ptt_transmissions', v_trans.id,
    jsonb_build_object('channel_id', p_channel_id, 'emergency', p_emergency)
  );

  return query select v_trans.id, v_trans.organization_id, v_trans.state, v_trans.started_at;
end;
$$;

revoke all on function public.open_ptt_transmission from public, anon;
grant execute on function public.open_ptt_transmission to authenticated, service_role;

-- 3. Close PTT transmission RPC
create or replace function public.close_ptt_transmission(
  p_transmission_id uuid,
  p_state text DEFAULT 'ended',
  p_metadata jsonb DEFAULT NULL
) returns table (
  transmission_id uuid,
  state text,
  ended_at timestamptz
) language plpgsql security definer set search_path = public as $$
declare
  v_user_id uuid := auth.uid();
  v_trans public.ptt_transmissions%rowtype;
  v_final_state text := coalesce(p_state, 'ended');
begin
  if v_user_id is null then raise exception 'Authentication required'; end if;

  select t.* into v_trans from public.ptt_transmissions t where t.id = p_transmission_id for update;
  if not found then raise exception 'PTT transmission not found'; end if;
  if v_trans.speaker_user_id <> v_user_id and not public.is_admin_for_org(v_trans.organization_id) then
    raise exception 'Not authorised to update this PTT transmission';
  end if;

  if v_final_state not in ('ended', 'failed', 'emergency') then
    raise exception 'Invalid transmission end state %', p_state;
  end if;

  update public.ptt_transmissions
    set state = v_final_state,
        ended_at = clock_timestamp(),
        metadata = case when p_metadata is not null then metadata || p_metadata else metadata end
    where id = v_trans.id
    returning * into v_trans;

  insert into public.audit_log (
    organization_id, actor_user_id, action, target_table, target_id, metadata
  ) values (
    v_trans.organization_id, v_user_id, 'ptt_transmission_ended', 'ptt_transmissions', v_trans.id,
    jsonb_build_object('state', v_final_state, 'duration_ms', extract(epoch from (v_trans.ended_at - v_trans.started_at)) * 1000)
  );

  return query select v_trans.id, v_trans.state, v_trans.ended_at;
end;
$$;

revoke all on function public.close_ptt_transmission from public, anon;
grant execute on function public.close_ptt_transmission to authenticated, service_role;

-- 4. Record radio transcript segment RPC
create or replace function public.record_radio_transcript_segment(
  p_transmission_id uuid,
  p_sequence integer,
  p_text text,
  p_confidence real DEFAULT 1.0,
  p_is_final boolean DEFAULT true
) returns table (
  segment_id uuid,
  transmission_id uuid,
  sequence integer,
  created_at timestamptz
) language plpgsql security definer set search_path = public as $$
declare
  v_user_id uuid := auth.uid();
  v_trans public.ptt_transmissions%rowtype;
  v_segment public.radio_transcript_segments%rowtype;
  v_clean_text text := nullif(trim(coalesce(p_text, '')), '');
begin
  if v_user_id is null then raise exception 'Authentication required'; end if;
  if v_clean_text is null then raise exception 'Transcript text is required'; end if;

  select t.* into v_trans from public.ptt_transmissions t where t.id = p_transmission_id;
  if not found then raise exception 'PTT transmission not found'; end if;
  if v_trans.speaker_user_id <> v_user_id and not public.is_admin_for_org(v_trans.organization_id) then
    raise exception 'Not authorised to transcribe this PTT transmission';
  end if;

  insert into public.radio_transcript_segments (
    organization_id, transmission_id, sequence, text, confidence, is_final
  ) values (
    v_trans.organization_id, v_trans.id, coalesce(p_sequence, 1), v_clean_text, coalesce(p_confidence, 1.0), coalesce(p_is_final, true)
  ) returning * into v_segment;

  return query select v_segment.id, v_segment.transmission_id, v_segment.sequence, v_segment.created_at;
end;
$$;

revoke all on function public.record_radio_transcript_segment from public, anon;
grant execute on function public.record_radio_transcript_segment to authenticated, service_role;
