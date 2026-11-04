import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
type Row = Record<string, unknown>;
const row = (value: unknown): Row => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Incomplete briefing response');
  return value as Row;
};
const text = (value: unknown): string => typeof value === 'string' ? value : '';
const narrative = (value: unknown): string => {
  if (value === null) return '';
  if (typeof value !== 'string') throw new Error('Invalid briefing narrative');
  return value;
};
const pick = (value: Row, keys: string[]): Row => Object.fromEntries(keys.map((key) => [key, value[key]]));
const rows = (value: unknown): Row[] => {
  if (!Array.isArray(value)) throw new Error('Incomplete safety briefing');
  return value.map(row);
};

export async function handleOfficerShiftBriefing(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return reply({ error: 'POST required' }, 405);
  try {
    const auth = req.headers.get('Authorization');
    if (!auth) return reply({ error: 'Authentication required' }, 401);
    const url = Deno.env.get('SUPABASE_URL') ?? '';
    const caller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY') ?? '', { global: { headers: { Authorization: auth } } });
    const { data: identity, error: authError } = await caller.auth.getUser();
    if (authError || !identity.user) return reply({ error: 'Authentication required' }, 401);
    const body = await req.json();
    const shiftId = body.shift_id;
    if (shiftId != null && !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(shiftId)) return reply({ error: 'Invalid shift ID' }, 400);
    const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');
    const { data: profile, error: profileError } = await admin.from('user_profiles').select('deactivated_at').eq('id', identity.user.id).single();
    if (profileError || !profile || profile.deactivated_at) return reply({ error: 'Active officer identity required' }, 403);
    // The existing RPC establishes ownership and the active agreement/module path before any privileged read.
    const { data: postData, error: postError } = await caller.rpc('get_officer_static_post', { p_shift_id: shiftId ?? null });
    if (postError) return reply({ error: postError.message }, 403);
    if (!postData) return reply({ post: null, safety: null });
    const post = row(postData), shift = row(post.shift), place = row(post.place), stop = row(post.stop);
    const { data: safetyData, error: safetyError } = await caller.rpc('get_shift_safety_briefing', { p_shift_id: shift.id, p_stop_id: null });
    if (safetyError || !safetyData) return reply({ error: 'Safety briefing could not be confirmed' }, 502);
    const safety = row(safetyData), hazards = rows(safety.hazards), warnings = rows(safety.warnings);
    const fields: Record<string, string> = {
      shift_notes: narrative(shift.notes), officer_notes: narrative(stop.officer_notes),
      site_brief: narrative(place.site_brief), access_instructions: narrative(place.access_instructions), hs_notes: narrative(place.hs_notes),
    };
    hazards.forEach((hazard, i) => {
      fields[`hazard_${i}_title`] = narrative(hazard.title);
      fields[`hazard_${i}_details`] = narrative(hazard.details);
      if (!Array.isArray(hazard.controls) || hazard.controls.some((control) => typeof control !== 'string')) throw new Error('Invalid safety controls');
      hazard.controls.forEach((control, j) => { fields[`hazard_${i}_control_${j}`] = control; });
    });
    warnings.forEach((warning, i) => { fields[`warning_${i}`] = narrative(warning.reason); });
    const { data: site, error: siteError } = await admin.from('client_sites')
      .select('gps_lat,gps_lng,client_organization_id,boundary_verification').eq('id', place.id).maybeSingle();
    if (siteError) return reply({ error: 'Assigned site details could not be confirmed' }, 502);
    const { data: contacts, error: contactsError } = site
      ? await admin.from('crm_contacts').select('id,first_name,last_name,role_title,phone,mobile,is_primary,is_emergency')
        .eq('organization_id', site.client_organization_id).is('deactivated_at', null).or('is_primary.eq.true,is_emergency.eq.true').limit(4)
      : { data: [], error: null };
    if (contactsError) return reply({ error: 'Operational contacts could not be confirmed' }, 502);
    const { data: slot, error: slotError } = await admin.from('roster_slots').select('work_unit_id').eq('linked_shift_id', shift.id).maybeSingle();
    if (slotError) return reply({ error: 'Shift requirements could not be confirmed' }, 502);
    const { data: unit, error: unitError } = slot
      ? await admin.from('roster_work_units').select('name,organization_id,required_skill_names,required_skill_ids').eq('id', slot.work_unit_id).single()
      : { data: null, error: null };
    if (unitError) return reply({ error: 'Work requirements could not be confirmed' }, 502);
    const skillIds = unit?.required_skill_ids ?? [];
    const { data: skills, error: skillsError } = unit && skillIds.length
      ? await admin.from('roster_skill_catalog').select('id,skill_name').eq('organization_id', unit.organization_id).in('id', skillIds)
      : { data: [], error: null };
    if (skillsError || skills?.length !== skillIds.length) return reply({ error: 'Required skill details could not be confirmed' }, 502);
    const requirements = [...new Set([...(unit?.required_skill_names ?? []), ...(skills ?? []).map((skill) => skill.skill_name)])];
    let checked: Record<string, string | null> = {};
    let privacy: Row = { status: 'unavailable', message: 'Private Oracle review is unavailable. Briefing text and H&S details are withheld; contact operations before starting.' };
    const controlBase = (Deno.env.get('BOB_CONTROL_PLANE_URL') ?? Deno.env.get('FCM_API_URL') ?? '').replace(/\/+$/, '').replace(/\/api(?:\/bob)?(?:\/builder)?$/, '');
    const controlToken = Deno.env.get('BOB_ADMIN_TOKEN') ?? Deno.env.get('FCM_API_TOKEN');
    if (controlBase && controlToken) {
      try {
        const response = await fetch(`${controlBase}/api/bob/officer/privacy`, {
          method: 'POST', headers: { Authorization: `Bearer ${controlToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ fields }), redirect: 'error', signal: AbortSignal.timeout(90_000),
        });
        if (!response.ok) throw new Error('Private review unavailable');
        const result = row(await response.json()), reviewed = row(result.fields), receipt = row(result.privacy);
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(Object.entries(fields))));
        const sourceHash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
        if (!['checked', 'partly_withheld'].includes(text(receipt.status)) || !['gpu_workstation', 'ollama'].includes(text(receipt.provider))
          || receipt.source_hash !== sourceHash || !text(receipt.model)
          || Object.keys(reviewed).length !== Object.keys(fields).length
          || Object.keys(fields).some((key) => !Object.hasOwn(reviewed, key) || (reviewed[key] !== null && typeof reviewed[key] !== 'string')
            || (receipt.status === 'checked' && reviewed[key] === null))) throw new Error('Invalid private review receipt');
        checked = reviewed as Record<string, string | null>;
        privacy = receipt;
      } catch {
        console.error('[officer-shift-briefing] private Oracle review unavailable; no narrative disclosed');
      }
    }
    const read = (key: string) => checked[key] || null;
    const safeSafety = privacy.status === 'checked' ? {
      ...pick(safety, ['shift_id', 'stop_id', 'shift_status', 'places', 'item_count', 'briefing_hash', 'acknowledgement_required', 'acknowledged', 'acknowledged_at', 'changed_since_acknowledgement', 'is_assigned_officer']),
      hazards: hazards.map((hazard, i) => ({
        ...pick(hazard, ['id', 'hazard_class', 'risk_level', 'status', 'origin', 'version', 'place_name', 'place_kind', 'source_as_of', 'updated_at']),
        title: checked[`hazard_${i}_title`], details: read(`hazard_${i}_details`),
        controls: (hazard.controls as string[]).map((_, j) => checked[`hazard_${i}_control_${j}`]),
        source_name: null, source_locator: null, has_source_document: false, recorded_by: 'Your organisation',
      })),
      warnings: warnings.map((warning, i) => ({ ...pick(warning, ['id', 'hazard_class', 'alert_level', 'raised_at', 'organization_name', 'contact_phone']), reason: read(`warning_${i}`) })),
    } : null;
    return reply({
      post: {
        module: pick(row(post.module), ['id', 'status', 'started_at', 'completed_at']),
        attendance_evidence: post.attendance_evidence,
        shift: { ...pick(shift, ['id', 'status', 'scheduled_start', 'scheduled_end']), notes: read('shift_notes') },
        stop: { ...pick(stop, ['id', 'status', 'sla_arrive_by', 'actual_arrived_at', 'actual_departed_at']), officer_notes: read('officer_notes') },
        place: { ...pick(place, ['id', 'name', 'address', 'risk_level']), site_brief: read('site_brief'), access_instructions: read('access_instructions'), hs_notes: read('hs_notes'), gps_lat: site?.gps_lat ?? null, gps_lng: site?.gps_lng ?? null, boundary_verified: site?.boundary_verification === 'verified' },
      },
      safety: safeSafety, privacy, requirements, work_unit_name: unit?.name ?? null,
      contacts: (contacts ?? []).map((contact) => ({ id: contact.id, name: [contact.first_name, contact.last_name].filter(Boolean).join(' '), role: contact.role_title, phone: contact.mobile || contact.phone, kind: contact.is_emergency ? 'Client emergency contact' : 'Client primary contact' })),
    });
  } catch {
    console.error('[officer-shift-briefing] briefing request failed; no narrative disclosed');
    return reply({ error: 'Shift briefing could not be loaded. Retry or contact operations.' }, 500);
  }
}
