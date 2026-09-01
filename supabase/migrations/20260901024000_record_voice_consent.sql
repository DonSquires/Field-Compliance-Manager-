-- Voice consent self-attestation for the PTT universal translator pipeline
-- (#ptt-radio-gap). radio_voice_consents was SELECT-only -- present in
-- schema ("Consent is required before voice profile registration and is
-- fully revocable"), with no way for anyone to actually grant or revoke
-- consent. Consent must always be self-attested, so this is an RPC rather
-- than an open INSERT/UPDATE policy.
--
-- DEFERRED (documented, not built here): the live PTT audio/floor-control
-- UI (WebRTC), persisting ptt-server's in-memory channel state into
-- ptt_transmissions, and the STT/translation pipeline
-- (radio_transcript_segments/radio_translation_segments) all require
-- real-time media infrastructure and a speech-to-text vendor integration
-- (see the separate fieldops-railway-stt service) well beyond this
-- migration's scope.

create or replace function public.record_voice_consent(
  p_consented boolean
) returns table(id uuid, consented boolean, revoked_at timestamptz)
language plpgsql security definer set search_path to 'public' as $$
declare
  v_user_id uuid := auth.uid();
  v_org_id uuid;
  v_existing radio_voice_consents%rowtype;
  v_id uuid;
  v_revoked_at timestamptz;
begin
  if v_user_id is null then raise exception 'Authentication required'; end if;

  select organization_id into v_org_id from user_profiles where id = v_user_id and deactivated_at is null;
  if v_org_id is null then raise exception 'Active profile required'; end if;

  select * into v_existing from radio_voice_consents
  where user_id = v_user_id and organization_id = v_org_id
  order by created_at desc limit 1;

  v_revoked_at := case when not p_consented then now() else null end;

  if found and v_existing.consented = p_consented then
    return query select v_existing.id, v_existing.consented, v_existing.revoked_at;
    return;
  end if;

  insert into radio_voice_consents (organization_id, user_id, consented, revoked_at)
  values (v_org_id, v_user_id, p_consented, v_revoked_at)
  returning radio_voice_consents.id into v_id;

  insert into audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (v_org_id, v_user_id, case when p_consented then 'voice_consent_granted' else 'voice_consent_revoked' end, 'radio_voice_consents', v_id, '{}'::jsonb);

  return query select v_id, p_consented, v_revoked_at;
end;
$$;

alter function public.record_voice_consent(boolean) owner to postgres;
comment on function public.record_voice_consent(boolean) is 'Self-attested voice consent grant/revoke for the PTT universal translator pipeline. Always self-scoped to auth.uid(); audited.';
revoke all on function public.record_voice_consent(boolean) from public, anon;
grant execute on function public.record_voice_consent(boolean) to authenticated, service_role;
