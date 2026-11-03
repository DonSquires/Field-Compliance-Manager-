-- Report incident triage: Bob reads each month's logged activity and officer
-- notes and highlights entries that may be incidents; a provider reviewer then
-- confirms each one as an incident or clears it. Confirmed entries are shown
-- to the client under Incidents and Investigations. Rows are keyed by the
-- agreement and a content key of the frozen activity line (the snapshot lines
-- carry no record id), so a decision survives a pack being regenerated.

create table public.report_incident_triage (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  service_agreement_id uuid not null references public.service_agreements(id) on delete cascade,
  line_key text not null check (line_key ~ '^v1:[0-9a-f]{14}$'),
  line_date date not null,
  place text,
  excerpt text check (length(excerpt) <= 1000),
  bob_flagged boolean not null default false,
  bob_incident_type text,
  bob_reason text check (length(bob_reason) <= 600),
  bob_confidence numeric(3, 2) check (bob_confidence between 0 and 1),
  bob_model text,
  bob_assessed_at timestamptz,
  decision text not null default 'unreviewed' check (decision in ('unreviewed', 'incident', 'not_incident')),
  incident_type text,
  decision_note text check (length(decision_note) <= 1000),
  decided_by uuid references auth.users(id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint report_incident_triage_line_unique unique (service_agreement_id, line_key),
  constraint report_incident_triage_type_known check (
    (incident_type is null or incident_type in ('theft', 'trespass', 'perimeter_compromise', 'vandalism', 'surveillance_tampering', 'hardware_failure', 'illegal_hunting', 'dumping', 'fire', 'safety_hazard', 'other'))
    and (bob_incident_type is null or bob_incident_type in ('theft', 'trespass', 'perimeter_compromise', 'vandalism', 'surveillance_tampering', 'hardware_failure', 'illegal_hunting', 'dumping', 'fire', 'safety_hazard', 'other'))
  ),
  constraint report_incident_triage_decided check (
    (decision = 'unreviewed' and decided_at is null)
    or (decision <> 'unreviewed' and decided_at is not null)
  )
);

comment on table public.report_incident_triage is 'Bob''s potential-incident flags on client report activity lines and the provider reviewer''s decision (incident / not_incident). Keyed by agreement and a content key of the frozen line (v1: hash of every content field except photo and video counts and refs). excerpt is the already-redacted client-facing line text. Written only by the flag-report-potential-incidents edge function (Bob fields) and set_report_incident_triage (decision fields).';

create index report_incident_triage_agreement_date_idx on public.report_incident_triage (service_agreement_id, line_date);
create index report_incident_triage_org_idx on public.report_incident_triage (organization_id);
create index report_incident_triage_decided_by_idx on public.report_incident_triage (decided_by) where decided_by is not null;

alter table public.report_incident_triage enable row level security;
revoke all on table public.report_incident_triage from public, anon, authenticated;
grant all on table public.report_incident_triage to service_role;

-- Reviewer read path: the triage rows inside one pack's period.
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
      'decided_at', t.decided_at
    ) order by t.line_date, t.line_key)
    from public.report_incident_triage t
    where t.service_agreement_id = v_pack.service_agreement_id
      and t.line_date between v_pack.period_start and v_pack.period_end
  ), '[]'::jsonb);
end;
$function$;

comment on function public.list_report_incident_triage(uuid) is 'Returns Bob''s potential-incident flags and reviewer decisions for the activity lines inside one report pack''s period. Report provider custodians only.';
revoke all on function public.list_report_incident_triage(uuid) from public, anon, authenticated, service_role;
grant execute on function public.list_report_incident_triage(uuid) to authenticated;

-- Reviewer decision path: three states, audited.
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
  if v_pack.status not in ('draft', 'generated') then
    raise exception 'Sent report packs cannot be changed';
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
  -- A decision delivered in a sent report is part of that record and is fixed.
  if exists (
    select 1
    from public.monthly_report_packs sent
    where sent.service_agreement_id = v_pack.service_agreement_id
      and sent.status = 'sent'
      and v_line_date between sent.period_start and sent.period_end
  ) then
    raise exception 'This entry is in a report that has already been sent, so its decision cannot be changed';
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
      'pdfs_invalidated', v_stale_pdfs
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
    'pdf_needs_regenerating', v_stale_pdfs > 0
  );
end;
$function$;

comment on function public.set_report_incident_triage(uuid, text, text, text, text) is 'Records a provider reviewer''s decision on an activity line Bob has checked: unreviewed, incident (with a type) or not_incident. Report provider custodians only, packs in draft or generated status only, and never for an entry already delivered in a sent pack. A changed decision clears pdf_source_updated_at on unsent packs covering the entry so their PDF must be generated again; writes an audit_log receipt.';
revoke all on function public.set_report_incident_triage(uuid, text, text, text, text) from public, anon, authenticated, service_role;
grant execute on function public.set_report_incident_triage(uuid, text, text, text, text) to authenticated;

-- Server-only: the two calendar months before a pack, for Bob's trend comparison.
create or replace function public.report_pack_trend_context(p_pack_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'pg_catalog'
as $function$
declare
  v_pack record;
  v_month date;
  v_report jsonb;
  v_months jsonb := '[]'::jsonb;
begin
  select pack.id, pack.service_agreement_id, pack.period_start
  into v_pack
  from public.monthly_report_packs pack
  where pack.id = p_pack_id;
  if v_pack.id is null then
    raise exception 'Report pack not found';
  end if;
  for i in 1..2 loop
    v_month := (date_trunc('month', v_pack.period_start::timestamp) - make_interval(months => i))::date;
    v_report := public.build_agreement_activity_report(
      v_pack.service_agreement_id,
      v_month::timestamp at time zone 'Pacific/Auckland',
      (v_month + interval '1 month')::timestamp at time zone 'Pacific/Auckland',
      0
    ) -> 'report';
    v_months := v_months || jsonb_build_array(jsonb_build_object(
      'month', to_char(v_month, 'YYYY-MM'),
      'report', case when v_report is null then null else jsonb_strip_nulls(jsonb_build_object(
        'version', v_report -> 'version',
        'totals', v_report -> 'totals',
        'categories', v_report -> 'categories',
        'incidents', v_report -> 'incidents',
        'observations', v_report -> 'observations',
        'pestControl', v_report -> 'pestControl',
        'hunterReturns', v_report -> 'hunterReturns',
        'labels', v_report -> 'labels'
      )) end,
      'confirmedIncidents', coalesce((
        select jsonb_agg(jsonb_build_object('type', grouped.incident_type, 'count', grouped.n) order by grouped.n desc, grouped.incident_type)
        from (
          select t.incident_type, count(*)::integer as n
          from public.report_incident_triage t
          where t.service_agreement_id = v_pack.service_agreement_id
            and t.decision = 'incident'
            and t.line_date >= v_month
            and t.line_date < (v_month + interval '1 month')::date
          group by t.incident_type
        ) grouped
      ), '[]'::jsonb)
    ));
  end loop;
  return jsonb_build_object('months', v_months);
end;
$function$;

comment on function public.report_pack_trend_context(uuid) is 'Server-only: the report figures (no itemised lines) for the two calendar months before a pack, plus reviewer-confirmed incidents by type, so Bob can compare the period with the previous two months. Called by draft-report-executive-summary with the service role after its own custodian check.';
revoke all on function public.report_pack_trend_context(uuid) from public, anon, authenticated, service_role;
grant execute on function public.report_pack_trend_context(uuid) to service_role;

-- Bob's knowledge and training cards for incident triage. Platform cards
-- (organization_id null); providers can add their own cards in the same
-- category. Embeddings are filled by the card embedder.
insert into public.bob_knowledge_cards (organization_id, category, key, title, content, tags, source)
select null, card.category, card.key, card.title, card.content, card.tags, 'migration:20261105100000_report_incident_triage'
from (values
  ('report_incident_triage', 'report_incident_triage.knowledge.purpose', 'Incident triage: what you are deciding',
   'You read a month of logged field activity (patrols, site checks, CCTV reviews, observations, pest control, maintenance) for a forestry or land-management client and point out entries that may be incidents the client should know about. An incident is an event that harmed, threatened or exposed the client''s land, assets, people or obligations: something happened that should not have, or a control failed. Routine work done as planned is not an incident, even when it is written up in detail. You only highlight; a provider reviewer confirms or clears every highlight. Prefer recall over precision for serious matters (theft, perimeter compromise, tampering, fire, firearms) and precision for minor matters. Judge the meaning of the whole entry, not individual words: "checked the gate, all secure" is routine; "gate found open, chain cut" is not.',
   array['incident', 'triage', 'reports']),
  ('report_incident_triage', 'report_incident_triage.knowledge.taxonomy', 'Incident triage: types',
   'Use one type per highlight. theft: property, fuel, machinery, tools, timber, firewood, equipment or cameras taken or found missing. trespass: people or vehicles where they are not permitted, confirmed by sighting, footage, tracks or admission. perimeter_compromise: gates, locks, chains, bollards, roadblock logs or fences bypassed, forced, cut, moved or winched aside to gain access. vandalism: deliberate damage, graffiti, burnt-out or dumped-and-damaged property, shot signs. surveillance_tampering: cameras moved, covered, damaged, discovered and interfered with, SD cards removed or wiped. hardware_failure: security hardware that failed and left access uncontrolled or needed workarounds, such as electronic locks not opening or losing power, flat batteries needing external power, patrols cutting chains, or missing or broken locks and gates. illegal_hunting: hunting without a permit, spotlighting, firearms discharged where not allowed, animals shot in closed blocks. dumping: rubbish, vehicles, green waste or hazardous material left on the land. fire: fires, burn piles, fireworks or fire-risk activity. safety_hazard: a dangerous condition to people, such as slips, washed-out roads, fallen trees across roads or unsafe structures, that was not just routine maintenance. other: a serious event that fits none of these.',
   array['incident', 'taxonomy']),
  ('report_incident_triage', 'report_incident_triage.knowledge.not_incidents', 'Incident triage: what is not an incident',
   'Do not highlight: patrols and site checks that found everything secure; planned pest control, trapping, culls and bait station servicing (even with kills recorded); permitted hunters and recreational users seen with valid permits; scheduled maintenance, repairs and fabrication; routine CCTV reviews with nothing found or only wildlife or permitted users; administrative or desk entries; travel. A lock battery that was low but replaced on schedule before it failed is maintenance, not a failure. Weather or wildlife alone is not an incident unless it caused damage or a hazard to people.',
   array['incident', 'routine']),
  ('report_incident_triage', 'report_incident_triage.knowledge.context', 'Incident triage: New Zealand forestry context',
   'Clients are plantation forestry and land owners in New Zealand (for example OneFortyOne and Tasman Pine Forests). Common real problems are fuel and diesel theft from harvest crews, theft of machinery and tools, unauthorised 4WD and motorbike access, illegal firewood cutting, unpermitted hunting and spotlighting, roadblock logs winched aside, gates and chains cut, rubbish and stolen-vehicle dumping, fire risk in summer, and electronic gate locks (for example Master locks) that fail. Blocks and forests are named places (for example Smiths, Denckers, Kings Ridge, Teetotal). Vehicle registrations and descriptions are useful evidence. People named in entries have already been replaced with "a person has been identified"; never try to identify anyone.',
   array['incident', 'context', 'nz', 'forestry']),
  ('report_incident_triage', 'report_incident_triage.training.positive', 'Incident triage training: entries that are incidents',
   'Highlight these. "Roadblock log at Denckers winched to the side, fresh 4WD tracks past it" -> perimeter_compromise, high confidence. "Crew reported 1,300 L diesel and tools missing from the Smiths skid site" -> theft. "Camera at Teetotal found opened and SD card missing" -> surveillance_tampering. "Master lock would not open despite showing 100% battery; used 9V battery to power it" -> hardware_failure. "Lock dead, chain cut to get crew in, temporary padlock fitted" -> hardware_failure. "White Ford Ranger seen leaving the block through a closed gate" -> trespass. "Two shots heard after dark near the northern boundary, spotlight seen" -> illegal_hunting. "Car body dumped and burnt on the forest road" -> dumping (or vandalism if the damage is the main point). "Campfire still smouldering at the lookout" -> fire.',
   array['incident', 'training', 'positive']),
  ('report_incident_triage', 'report_incident_triage.training.negative', 'Incident triage training: entries that are not incidents',
   'Do not highlight these. "Patrolled the block, all gates locked and secure" -> routine. "Checked camera, swapped SD card and batteries, footage reviewed, deer only" -> routine maintenance. "Shot 3 goats and 1 pig during the cull" -> planned pest control. "Permit holder spoken to at the gate, permit sighted" -> permitted user. "Replaced the lock battery as part of the monthly check" -> maintenance. "Graded the road and cleared drains" -> maintenance. "Reviewed CCTV, two permitted contractors" -> routine. If an entry mixes routine work with a real problem ("patrol completed; found gate chain cut"), highlight it for the problem.',
   array['incident', 'training', 'negative'])
) as card(category, key, title, content, tags)
where not exists (
  select 1 from public.bob_knowledge_cards existing
  where existing.organization_id is null and existing.key = card.key and existing.is_active
);
