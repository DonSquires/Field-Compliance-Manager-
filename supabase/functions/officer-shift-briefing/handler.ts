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
    const shiftId = body.shift_id, stopId = body.stop_id ?? null;
    if (shiftId != null && !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(shiftId)) return reply({ error: 'Invalid shift ID' }, 400);
    if (stopId !== null && (!shiftId || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(stopId))) return reply({ error: 'Invalid stop ID' }, 400);
    const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');
    const { data: profile, error: profileError } = await admin.from('user_profiles').select('deactivated_at').eq('id', identity.user.id).single();
    if (profileError || !profile || profile.deactivated_at) return reply({ error: 'Active officer identity required' }, 403);
    // The existing RPC establishes ownership and the active agreement/module path before any privileged read.
    const { data: postData, error: postError } = await caller.rpc('get_officer_static_post', { p_shift_id: shiftId ?? null });
    if (postError) return reply({ error: postError.message }, 403);
    if (!postData) return reply({ post: null, safety: null });
    const post = row(postData), shift = row(post.shift), place = row(post.place), stop = row(post.stop), module = row(post.module);
    if (shiftId != null && shift.id !== shiftId) return reply({ error: 'Selected assignment could not be confirmed' }, 403);
    if (stopId !== null && stop.id !== stopId) return reply({ error: 'Stop is not part of this assignment' }, 403);
    const { data: safetyData, error: safetyError } = await caller.rpc('get_shift_safety_briefing', { p_shift_id: shift.id, p_stop_id: stopId });
    if (safetyError || !safetyData) return reply({ error: 'Safety briefing could not be confirmed' }, 502);
    const safety = row(safetyData), hazards = rows(safety.hazards), warnings = rows(safety.warnings);
    if (safety.shift_id !== shift.id || safety.stop_id !== stopId || safety.is_assigned_officer !== true) return reply({ error: 'Safety briefing context could not be confirmed' }, 502);
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
    const { data: assignedModule, error: assignedModuleError } = await admin.from('shift_stop_modules')
      .select('service_agreement_location_id,service_agreement_module_id').eq('id', module.id)
      .eq('shift_stop_id', stop.id).eq('module_key', 'static_guarding').eq('is_required', true).maybeSingle();
    if (assignedModuleError || !assignedModule?.service_agreement_location_id || !assignedModule.service_agreement_module_id) {
      return reply({ error: 'Assigned contract could not be confirmed' }, 502);
    }
    const [locationResult, moduleResult] = await Promise.all([
      admin.from('service_agreement_locations').select('service_agreement_id,site_id,zone_id')
        .eq('id', assignedModule.service_agreement_location_id).eq('status', 'active').maybeSingle(),
      admin.from('service_agreement_modules').select('service_agreement_id')
        .eq('id', assignedModule.service_agreement_module_id).eq('module_key', 'static_guarding').eq('enabled', true).maybeSingle(),
    ]);
    const location = locationResult.data, agreementModule = moduleResult.data;
    if (locationResult.error || moduleResult.error || !location || !agreementModule
      || location.service_agreement_id !== agreementModule.service_agreement_id
      || (location.site_id !== place.id && location.zone_id !== place.id)) {
      return reply({ error: 'Assigned contract and place could not be confirmed' }, 502);
    }
    const { data: site, error: siteError } = await admin.from('client_sites')
      .select('gps_lat,gps_lng,boundary_verification').eq('id', place.id).maybeSingle();
    if (siteError) return reply({ error: 'Assigned site details could not be confirmed' }, 502);
    const { data: slot, error: slotError } = await admin.from('roster_slots')
      .select('id,work_unit_id,staff_id,status,notes').eq('linked_shift_id', shift.id).maybeSingle();
    if (slotError) return reply({ error: 'Shift requirements could not be confirmed' }, 502);
    if (slot) {
      const { data: staff, error: staffError } = await admin.from('staff_profiles').select('id,user_id').eq('id', slot.staff_id).maybeSingle();
      if (staffError || !staff || (staff.user_id ?? staff.id) !== identity.user.id
        || !['published', 'accepted'].includes(slot.status)) {
        return reply({ error: 'Roster assignment could not be confirmed' }, 403);
      }
    }
    const { data: contact, error: contactError } = slot
      ? await admin.from('roster_slot_contacts').select('contact_name,contact_phone').eq('roster_slot_id', slot.id).maybeSingle()
      : { data: null, error: null };
    if (contactError) return reply({ error: 'Shift contact could not be confirmed' }, 502);
    const { data: unit, error: unitError } = slot
      ? await admin.from('roster_work_units')
        .select('name,organization_id,required_skill_names,required_skill_ids,service_agreement_location_id,service_agreement_module_id')
        .eq('id', slot.work_unit_id).single()
      : { data: null, error: null };
    if (unitError) return reply({ error: 'Work requirements could not be confirmed' }, 502);
    if (unit && (unit.service_agreement_location_id !== assignedModule.service_agreement_location_id
      || unit.service_agreement_module_id !== assignedModule.service_agreement_module_id)) {
      return reply({ error: 'Rostered work does not match the assigned contract' }, 502);
    }
    const skillIds = unit?.required_skill_ids ?? [];
    const { data: skills, error: skillsError } = unit && skillIds.length
      ? await admin.from('roster_skill_catalog').select('id,skill_name').eq('organization_id', unit.organization_id).in('id', skillIds)
      : { data: [], error: null };
    if (skillsError || skills?.length !== skillIds.length) return reply({ error: 'Required skill details could not be confirmed' }, 502);
    const requirements = unit ? [...new Set([...(unit.required_skill_names ?? []), ...(skills ?? []).map((skill) => skill.skill_name)])] : null;
    fields.roster_notes = narrative(slot?.notes ?? null);
    fields.work_unit_name = narrative(unit?.name ?? null);
    requirements?.forEach((requirement, i) => { fields[`requirement_${i}`] = narrative(requirement); });
    let checked: Record<string, string | null> = {};
    let privacy: Row = { status: 'unavailable', message: 'Private Oracle review is unavailable. Briefing text and H&S details are withheld; contact operations before starting.' };
    const controlBase = (Deno.env.get('BOB_CONTROL_PLANE_URL') ?? Deno.env.get('FCM_API_URL') ?? '').replace(/\/+$/, '').replace(/\/api(?:\/bob)?(?:\/builder)?$/, '');
    const controlToken = Deno.env.get('BOB_ADMIN_TOKEN') ?? Deno.env.get('FCM_API_TOKEN');
    if (controlBase && controlToken) {
      try {
        const response = await fetch(`${controlBase}/api/bob/officer/privacy`, {
          method: 'POST', headers: { Authorization: `Bearer ${controlToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ fields }), redirect: 'error', signal: AbortSignal.timeout(140_000),
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
      ...pick(safety, ['shift_id', 'stop_id', 'shift_status', 'item_count', 'briefing_hash', 'acknowledgement_required', 'acknowledged', 'acknowledged_at', 'changed_since_acknowledgement', 'is_assigned_officer']),
      places: rows(safety.places).map((item) => pick(item, ['kind', 'id', 'location_id', 'name'])),
      hazards: hazards.map((hazard, i) => ({
        ...pick(hazard, ['id', 'hazard_class', 'risk_level', 'status', 'origin', 'version', 'place_name', 'place_kind', 'source_as_of', 'updated_at']),
        title: checked[`hazard_${i}_title`], details: read(`hazard_${i}_details`),
        controls: (hazard.controls as string[]).map((_, j) => checked[`hazard_${i}_control_${j}`]),
        source_name: null, source_locator: null, has_source_document: false, recorded_by: 'Your organisation',
      })),
      warnings: warnings.map((warning, i) => ({ ...pick(warning, ['id', 'hazard_class', 'alert_level', 'raised_at', 'organization_name']), contact_phone: null, reason: read(`warning_${i}`) })),
    } : null;
    const attendance = row(post.attendance_evidence);
    const safeReceipt = (value: unknown) => value === null ? null : pick(row(value), ['reference', 'action', 'occurred_at', 'shift_id', 'stop_id', 'stop_status', 'module_status', 'gps_result', 'gps_accuracy_metres', 'timing_status', 'dwell_minutes', 'handover_recorded']);
    return reply({
      post: {
        module: pick(module, ['id', 'status', 'started_at', 'completed_at']),
        attendance_evidence: { arrival: safeReceipt(attendance.arrival), departure: safeReceipt(attendance.departure) },
        shift: { ...pick(shift, ['id', 'status', 'scheduled_start', 'scheduled_end']), notes: read('shift_notes') },
        stop: { ...pick(stop, ['id', 'status', 'sla_arrive_by', 'actual_arrived_at', 'actual_departed_at']), officer_notes: read('officer_notes') },
        place: { ...pick(place, ['id', 'name', 'address', 'risk_level']), site_brief: read('site_brief'), access_instructions: read('access_instructions'), hs_notes: read('hs_notes'), gps_lat: site?.gps_lat ?? null, gps_lng: site?.gps_lng ?? null, boundary_verified: site?.boundary_verification === 'verified' },
      },
      safety: safeSafety, privacy,
      requirements: privacy.status === 'checked' && requirements !== null ? requirements.map((_, i) => checked[`requirement_${i}`]) : null,
      roster_notes: read('roster_notes'), work_unit_name: read('work_unit_name'),
      contacts: slot && contact ? [{ id: slot.id, name: contact.contact_name || 'Shift contact', role: null, phone: contact.contact_phone, kind: 'Shift contact' }] : [],
    });
  } catch {
    console.error('[officer-shift-briefing] briefing request failed; no narrative disclosed');
    return reply({ error: 'Shift briefing could not be loaded. Retry or contact operations.' }, 500);
  }
}
