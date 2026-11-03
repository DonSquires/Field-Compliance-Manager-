-- Reclassifying a report entry after the report has been sent.
-- Owner ruling 2026-11-05: a reviewer must be able to escalate an entry to an
-- incident, or clear it, even when a report containing it has already been
-- sent, because new evidence can arrive later. Sent packs and their PDFs are
-- never changed; the decision moves forward into unsent and future packs, the
-- reviewer must record the reason, and audit_log marks the change as made
-- after delivery with the sent pack ids.

create or replace function public.list_report_incident_triage(p_pack_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'pg_catalog'
as $function$
declare
  v_pack record;
begin
  if auth.uid() is null then
    raise exception 'Authenticated provider administrator required';
  end if;
  select pack.id, pack.organization_id, pack.service_agreement_id, pack.period_start, pack.period_end
  into v_pack
  from public.monthly_report_packs pack
  where pack.id = p_pack_id;
  if v_pack.id is null then
    raise exception 'Report pack not found';
  end if;
  if not public.is_report_provider_custodian_for_org(v_pack.organization_id) then
    raise exception 'Provider administrator access required';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'line_key', t.line_key,
      'bob_flagged', t.bob_flagged,
      'bob_incident_type', t.bob_incident_type,
      'bob_reason', t.bob_reason,
      'bob_confidence', t.bob_confidence,
      'bob_assessed_at', t.bob_assessed_at,
      'decision', t.decision,
      'incident_type', t.incident_type,
      'decision_note', t.decision_note,
      'decided_at', t.decided_at,
      'in_sent_report', exists (
        select 1
        from public.monthly_report_packs sent
        where sent.service_agreement_id = t.service_agreement_id
          and sent.status = 'sent'
          and t.line_date between sent.period_start and sent.period_end
      )
    ) order by t.line_date, t.line_key)
    from public.report_incident_triage t
    where t.service_agreement_id = v_pack.service_agreement_id
      and t.line_date between v_pack.period_start and v_pack.period_end
  ), '[]'::jsonb);
end;
$function$;

comment on function public.list_report_incident_triage(uuid) is 'Returns Bob''s potential-incident flags and reviewer decisions for the activity lines inside one report pack''s period, with in_sent_report when a sent pack already covers the entry. Report provider custodians only.';
revoke all on function public.list_report_incident_triage(uuid) from public, anon, authenticated, service_role;
grant execute on function public.list_report_incident_triage(uuid) to authenticated;

create or replace function public.set_report_incident_triage(
  p_pack_id uuid,
  p_line_key text,
  p_decision text,
  p_incident_type text default null,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog'
as $function$
declare
  v_actor uuid := auth.uid();
  v_pack record;
  v_row public.report_incident_triage%rowtype;
  v_previous text;
  v_previous_type text;
  v_line_date date;
  v_stale_pdfs integer := 0;
  v_sent_packs uuid[];
  v_changes boolean;
  v_type text := nullif(btrim(coalesce(p_incident_type, '')), '');
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if v_actor is null then
    raise exception 'Authenticated provider administrator required';
  end if;
  if p_decision not in ('unreviewed', 'incident', 'not_incident') then
    raise exception 'Decision must be unreviewed, incident or not_incident';
  end if;
  if length(coalesce(v_note, '')) > 1000 then
    raise exception 'Review note exceeds 1000 characters';
  end if;
  if p_decision <> 'incident' then
    v_type := null;
  end if;

  select pack.id, pack.organization_id, pack.service_agreement_id, pack.period_start, pack.period_end, pack.status
  into v_pack
  from public.monthly_report_packs pack
  where pack.id = p_pack_id;
  if v_pack.id is null then
    raise exception 'Report pack not found';
  end if;
  if not public.is_report_provider_custodian_for_org(v_pack.organization_id) then
    raise exception 'Provider administrator access required';
  end if;

  select t.decision, t.incident_type, t.line_date into v_previous, v_previous_type, v_line_date
  from public.report_incident_triage t
  where t.service_agreement_id = v_pack.service_agreement_id
    and t.line_key = p_line_key
    and t.line_date between v_pack.period_start and v_pack.period_end
  for update;
  if not found then
    raise exception 'That entry has not been checked by Bob for this report';
  end if;
  -- New evidence can escalate or clear an entry after a report has been sent.
  -- The sent pack stays exactly as delivered; the change is a recorded
  -- reclassification and must carry the reason for it.
  select coalesce(array_agg(sent.id order by sent.period_start, sent.id), '{}')
  into v_sent_packs
  from public.monthly_report_packs sent
  where sent.service_agreement_id = v_pack.service_agreement_id
    and sent.status = 'sent'
    and v_line_date between sent.period_start and sent.period_end;
  v_changes := (p_decision, case when p_decision = 'incident' then coalesce(v_type, v_previous_type) end)
    is distinct from (v_previous, case when v_previous = 'incident' then v_previous_type end);
  if cardinality(v_sent_packs) > 0 and v_changes and length(coalesce(v_note, '')) < 10 then
    raise exception 'This entry was in a report already sent to the client. Record the reason or new evidence for the change (at least 10 characters).';
  end if;

  update public.report_incident_triage t
  set decision = p_decision,
      incident_type = case when p_decision = 'incident' then coalesce(v_type, t.bob_incident_type, 'other') end,
      decision_note = case when p_decision = 'unreviewed' then null else v_note end,
      decided_by = case when p_decision = 'unreviewed' then null else v_actor end,
      decided_at = case when p_decision = 'unreviewed' then null else clock_timestamp() end,
      updated_at = clock_timestamp()
  where t.service_agreement_id = v_pack.service_agreement_id
    and t.line_key = p_line_key
  returning * into v_row;

  -- The decision changes what the client report shows, so any PDF already
  -- generated for an unsent pack covering this entry is no longer current and
  -- must be generated again before sending. The pack trigger refuses this
  -- while an email delivery is in progress.
  update public.monthly_report_packs pack
  set pdf_source_updated_at = null
  where pack.service_agreement_id = v_pack.service_agreement_id
    and pack.status in ('draft', 'generated')
    and v_line_date between pack.period_start and pack.period_end
    and pack.pdf_source_updated_at is not null
    and (v_row.decision, v_row.incident_type) is distinct from (v_previous, v_previous_type);
  get diagnostics v_stale_pdfs = row_count;

  insert into public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (
    v_pack.organization_id,
    v_actor,
    'report_incident_triage_decided',
    'report_incident_triage',
    v_row.id,
    jsonb_build_object(
      'pack_id', v_pack.id,
      'line_key', v_row.line_key,
      'previous_decision', v_previous,
      'decision', v_row.decision,
      'incident_type', v_row.incident_type,
      'bob_flagged', v_row.bob_flagged,
      'bob_incident_type', v_row.bob_incident_type,
      'pdfs_invalidated', v_stale_pdfs,
      'after_delivery', cardinality(v_sent_packs) > 0,
      'sent_pack_ids', to_jsonb(v_sent_packs),
      'reason', case when cardinality(v_sent_packs) > 0 then v_note end
    )
  );

  return jsonb_build_object(
    'line_key', v_row.line_key,
    'bob_flagged', v_row.bob_flagged,
    'bob_incident_type', v_row.bob_incident_type,
    'bob_reason', v_row.bob_reason,
    'bob_confidence', v_row.bob_confidence,
    'bob_assessed_at', v_row.bob_assessed_at,
    'decision', v_row.decision,
    'incident_type', v_row.incident_type,
    'decision_note', v_row.decision_note,
    'decided_at', v_row.decided_at,
    'pdf_needs_regenerating', v_stale_pdfs > 0,
    'in_sent_report', cardinality(v_sent_packs) > 0
  );
end;
$function$;

comment on function public.set_report_incident_triage(uuid, text, text, text, text) is 'Records a provider reviewer''s decision on an activity line Bob has checked: unreviewed, incident (with a type) or not_incident. Report provider custodians only, from any pack covering the entry. When a sent pack already covers the entry, a changed decision needs a reason of at least 10 characters and is audited as after_delivery with the sent pack ids; sent packs are never changed. A changed decision clears pdf_source_updated_at on unsent packs covering the entry so their PDF must be generated again; writes an audit_log receipt.';
revoke all on function public.set_report_incident_triage(uuid, text, text, text, text) from public, anon, authenticated, service_role;
grant execute on function public.set_report_incident_triage(uuid, text, text, text, text) to authenticated;
