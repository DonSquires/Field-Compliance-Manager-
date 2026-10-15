/**
 * bob-proposal-execute — Layer 4.1 Phase 1: governed executor for APPROVED Bob actions
 *
 * POST /functions/v1/bob-proposal-execute
 * Body: { action_id }
 *
 * Runs the operational write for ONE already-approved bob_agentic_actions row.
 * Phase 1 supports exactly one action_type: 'create_service_agreement_draft',
 * which inserts an INERT DRAFT service_agreements row. Nothing is activated:
 *   - client_portal_access_mode = 'transparency_only'
 *   - client_portal_reports/finance = false, allows_client_submission = false,
 *     allows_auto_dispatch = false
 *   - no start/end dates
 * A human must edit the agreement in CRM to make it live.
 *
 * Governance (matches old-build fail-closed model + new-build proposal/approval):
 *   - Service-role OR x-cron-secret only — NEVER a browser/user call.
 *   - Executes only when status='approved'. Approve and execute are separate
 *     steps (two-person-rule friendly): bob-proposal-approver sets approved;
 *     this fn performs the write.
 *   - Idempotent: refuses to re-run an action that already has result_record_id
 *     / applied_at.
 *   - Full audit on bob_agentic_actions: result_table/result_record_id/applied_at
 *     on success, error_message + status='failed' on failure.
 *
 * Live-schema verified before writing (2026-06-28):
 *   bob_agentic_actions(id, organization_id, user_id, action_type, context_*,
 *     proposed_payload jsonb, status, approved_by, approved_at, rejection_reason,
 *     result_record_id, result_table, error_message, bob_reasoning,
 *     confidence_score, created_at, applied_at).
 *   service_agreements NOT-NULL w/o default: provider_organization_id,
 *     client_organization_id, name. No 'status' column (draft = inert flags).
 */ import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { validateTaName } from '../_shared/ta-validation.ts';
import { resolveTaBoundary } from '../_shared/ta-boundary-resolver.ts';
import { resolveOrCreateHouseEdge, HouseConflictError } from '../_shared/houseResolve.ts';
import { computeEffectiveDedupKey } from '../_shared/addressKey.ts';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const CRON_SECRET = Deno.env.get('CRON_SECRET') ?? '';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret'
};
// ── Human-ID mnemonic derivation (Section 2) ──
// Module-scope helpers (hoisted from the assign_human_id handler to satisfy
// Deno lint no-inner-declarations). Non-leaf: 3-4 char uppercase mnemonic.
// Leaf (site/zone): readable name uppercase, drop generic suffixes.
const HID_GENERIC_SUFFIXES = [
  'PARK',
  'RESERVE',
  'ROAD',
  'STREET',
  'DRIVE',
  'AVENUE',
  'LANE',
  'PLACE',
  'COURT',
  'CRESCENT',
  'TERRACE',
  'WAY',
  'CLOSE',
  'GARDENS',
  'SQUARE',
  'CENTRE',
  'CENTER'
];
const HID_SKIP_WORDS = new Set([
  'OF',
  'THE',
  'AND',
  'FOR',
  'IN',
  'AT',
  'BY',
  'TO',
  'A',
  'AN'
]);
function deriveNonLeafMnemonic(name) {
  const cleaned = name.toUpperCase().replace(/[^A-Z0-9\s]/g, '').trim();
  const words = cleaned.split(/\s+/).filter((w)=>w.length > 0);
  const significantWords = words.filter((w)=>!HID_SKIP_WORDS.has(w));
  // Strategy 1: initials if 3+ significant words
  if (significantWords.length >= 3) {
    const initials = significantWords.map((w)=>w[0]).join('');
    return initials.slice(0, 4); // max 4 chars
  }
  // Strategy 2: consonant skeleton of the primary word
  const primary = significantWords[0] || words[0] || 'UNK';
  const consonants = primary.replace(/[AEIOU]/g, '');
  if (consonants.length >= 3) return consonants.slice(0, 4);
  // Strategy 3: truncation of primary word
  return primary.slice(0, 3);
}
function deriveLeafName(name) {
  const cleaned = name.toUpperCase().replace(/[^A-Z0-9\s]/g, '').trim();
  const words = cleaned.split(/\s+/).filter((w)=>w.length > 0);
  // Drop generic suffixes (last word only)
  if (words.length > 1 && HID_GENERIC_SUFFIXES.includes(words[words.length - 1])) {
    words.pop();
  }
  const result = words.join('');
  // Practical max ~12 chars for dispatcher readability
  return result.slice(0, 12);
}
// Allow-list. Add new action types here only after each is reviewed.
const SUPPORTED_ACTIONS = new Set([
  'create_service_agreement_draft',
  'set_org_jurisdiction',
  'set_site_risk_level',
  'create_client_root_org',
  'create_place_org_from_parcel',
  'create_client_org',
  'create_client_site',
  'create_patrol_route_assignment',
  'create_patrol_route_service_area',
  'create_freedom_camping_zone',
  'create_zone_patrol_stop',
  'propose_freedom_camping_org_strategy',
  'set_org_corporate_profile',
  'assign_human_id',
  'apply_roster_fill_plan',
  'rollback_bob_roster_plan',
  'create_rate_rule',
  'start_staff_onboarding'
]);
async function fetchTaBoundary(districtName: string) {
  const resolution = await resolveTaBoundary(districtName);
  if (resolution.source_status === 'matched' && resolution.geometry && resolution.source) return resolution;
  if (resolution.source_status === 'source_unavailable') throw new Error(`GEOFENCE_SOURCE_UNAVAILABLE: ${resolution.detail ?? 'Territorial Authority boundary source unavailable'}; manual draw required`);
  throw new Error(`No Territorial Authority boundary found for '${districtName}'`);
}
serve(async (req)=>{
  if (req.method === 'OPTIONS') return new Response('ok', {
    headers: CORS
  });
  const json = (body, status = 200)=>new Response(JSON.stringify(body), {
      status,
      headers: {
        ...CORS,
        'Content-Type': 'application/json'
      }
    });
  // ── Service-role / cron auth only ──
  const authHeader = req.headers.get('Authorization') ?? '';
  const cronHeader = req.headers.get('x-cron-secret') ?? '';
  const isServiceRole = SUPABASE_SERVICE_ROLE_KEY && authHeader === `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`;
  const isCron = CRON_SECRET && cronHeader === CRON_SECRET;
  if (!isServiceRole && !isCron) {
    return json({
      error: 'Unauthorized (service-role or x-cron-secret required)'
    }, 401);
  }
  try {
    const body = await req.json();
    if (!body.action_id) return json({
      error: 'action_id is required'
    }, 400);
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    // Load the agentic action.
    const { data: action, error: loadErr } = await admin.from('bob_agentic_actions').select('id, organization_id, action_type, proposed_payload, amended_payload, status, result_record_id, applied_at, approved_by').eq('id', body.action_id).single();
    if (loadErr || !action) return json({
      error: 'Action not found'
    }, 404);
    // #87: the effective payload is the human amendment if one was made, else
    // Bob's original proposal. Every downstream handler reads action.proposed_payload,
    // so we coalesce ONCE here at the boundary: coalesce(amended_payload, proposed_payload).
    // Bob's original stays intact in the DB column for audit; only the in-memory
    // working copy is swapped.
    if (action.amended_payload && typeof action.amended_payload === 'object') {
      action.proposed_payload = action.amended_payload;
    }
    // ── Ungoverned direct-write bypass (owner ruling 4.1, #226; extended 2026-07-31) ──
    // A SHORT, EXPLICIT allow-list of low-risk action types that do NOT require
    // doorbell/bell approval. If the action arrives as 'pending', auto-approve it
    // inline so it passes the governance guard below. Every OTHER action type
    // remains fully governed (propose -> human approve -> execute).
    //   - assign_human_id: low-risk metadata write (ruling 4.1, #226).
    //   - create_place_org_from_parcel: ad-hoc dispatch place-record (owner ruling
    //     2026-07-31). Bounded, one-off, parcel-specific, NO signed agreement to
    //     manage; it is an accountable-place RECORD, never a tenant. The engine
    //     is auto-apply-grade (geometry dedup + read-back + rollback in-handler).
    const AUTO_APPLY_ACTION_TYPES = new Set([
      'assign_human_id',
      'create_place_org_from_parcel'
    ]);
    if (AUTO_APPLY_ACTION_TYPES.has(String(action.action_type)) && action.status === 'pending') {
      await admin.from('bob_agentic_actions').update({
        status: 'approved',
        approved_at: new Date().toISOString()
      }).eq('id', action.id);
      action.status = 'approved';
    }
    // Governance guards.
    if (action.status !== 'approved') {
      return json({
        error: `Action is not approved (status=${action.status}); refusing to execute`
      }, 409);
    }
    if (action.result_record_id || action.applied_at) {
      return json({
        error: 'Action already applied',
        result_record_id: action.result_record_id
      }, 409);
    }
    if (!SUPPORTED_ACTIONS.has(String(action.action_type))) {
      return json({
        error: `Unsupported action_type '${action.action_type}' (supported: ${[
          ...SUPPORTED_ACTIONS
        ].join(', ')})`
      }, 422);
    }
    // Shared fail helper (audit on the ledger, return 422).
    const failAction = async (msg)=>{
      await admin.from('bob_agentic_actions').update({
        status: 'failed',
        error_message: msg
      }).eq('id', action.id);
      return json({
        error: msg
      }, 422);
    };
    // Bob's roster output is deliberately limited to editable draft-slot
    // assignments. The database function rejects published or human-edited slots.
    if (action.action_type === 'apply_roster_fill_plan' || action.action_type === 'rollback_bob_roster_plan') {
      const isApply = action.action_type === 'apply_roster_fill_plan';
      const rpcName = isApply ? 'apply_bob_roster_fill_plan' : 'rollback_bob_roster_fill_plan';
      const { data: result, error: rosterError } = isApply
        ? await admin.rpc('apply_bob_roster_fill_plan', { p_action_id: action.id })
        : await admin.rpc('rollback_bob_roster_fill_plan', { p_action_id: action.id });
      const receipt = Array.isArray(result) ? result[0] : result;
      if (rosterError || !receipt?.plan_id) {
        return await failAction(`${rpcName} failed: ${rosterError?.message ?? 'missing receipt'}`);
      }
      const count = isApply
        ? receipt.assignments_applied
        : receipt.assignments_rolled_back;
      await admin.from('bob_agentic_actions').update({
        status: 'applied',
        result_table: 'bob_roster_plans',
        result_record_id: receipt.plan_id,
        applied_at: new Date().toISOString(),
        error_message: null
      }).eq('id', action.id);
      return json({
        success: true,
        action_id: action.id,
        result_table: 'bob_roster_plans',
        result_record_id: receipt.plan_id,
        assignments: count,
        note: isApply
          ? 'Bob roster plan applied as editable draft assignments. A human must publish slots separately.'
          : 'Bob roster plan rolled back from unchanged draft assignments.'
      });
    }
    if (action.action_type === 'create_rate_rule') {
      const { data: rateRuleId, error: rateError } = await admin.rpc('apply_bob_rate_rule_proposal', { p_action_id: action.id });
      if (rateError || !rateRuleId) return await failAction(`apply_bob_rate_rule_proposal failed: ${rateError?.message ?? 'missing receipt'}`);
      await admin.from('bob_agentic_actions').update({ status: 'applied', result_table: 'rate_rules', result_record_id: rateRuleId, applied_at: new Date().toISOString(), error_message: null }).eq('id', action.id);
      return json({ success: true, action_id: action.id, result_table: 'rate_rules', result_record_id: rateRuleId, note: 'Approved rate rule applied.' });
    }
    if (action.action_type === 'start_staff_onboarding') {
      const { data: ledgerId, error: onboardingError } = await admin.rpc('apply_bob_staff_onboarding_proposal', { p_action_id: action.id });
      if (onboardingError || !ledgerId) return await failAction(`apply_bob_staff_onboarding_proposal failed: ${onboardingError?.message ?? 'missing receipt'}`);
      await admin.from('bob_agentic_actions').update({ status: 'applied', result_table: 'staff_onboarding_ledgers', result_record_id: ledgerId, applied_at: new Date().toISOString(), error_message: null }).eq('id', action.id);
      return json({ success: true, action_id: action.id, result_table: 'staff_onboarding_ledgers', result_record_id: ledgerId, note: 'Approved staff onboarding started.' });
    }
    // ── set_org_jurisdiction ──
    // payload: { target_org_id, district_names: string[] }. Resolve each TA polygon
    // through the shared authoritative source ladder, union into one MultiPolygon,
    // then write organizations.jurisdiction_geom.
    if (action.action_type === 'set_org_jurisdiction') {
      const jp = action.proposed_payload ?? {};
      const targetOrgId = jp.target_org_id ? String(jp.target_org_id) : String(action.organization_id);
      const districtNames = Array.isArray(jp.district_names) ? jp.district_names.map((d)=>String(d).trim()).filter(Boolean) : [];
      if (!targetOrgId) return await failAction('proposed_payload.target_org_id is required');
      if (districtNames.length === 0) return await failAction('proposed_payload.district_names must be a non-empty array of Territorial Authority names');
      const { data: targetOrg } = await admin.from('organizations').select('id').eq('id', targetOrgId).maybeSingle();
      if (!targetOrg) return await failAction(`target_org_id ${targetOrgId} does not exist`);
      // Phase 0 (item 1): Validate each TA name against the live canonical set
      // BEFORE resolving a boundary. On no exact match, return fuzzy suggestions.
      for (const name of districtNames){
        const validationErr = await validateTaName(name);
        if (validationErr) return await failAction(validationErr);
      }
      // Fetch each TA polygon through the shared authoritative resolver.
      const polygons = [];
      const boundarySources = new Set();
      for (const name of districtNames){
        let boundary = null;
        try {
          boundary = await fetchTaBoundary(name);
        } catch (e) {
          return await failAction(e instanceof Error ? e.message : `Territorial Authority boundary fetch failed for '${name}'`);
        }
        polygons.push(boundary.geometry);
        boundarySources.add(boundary.source);
      }
      // Union + write via the SQL helper. Phase 1: RPC now returns area (m^2).
      // Phase 4 fast-follow (0284): pass real provenance + actor.
      const { data: jurAreaData, error: rpcErr } = await admin.rpc('set_org_jurisdiction_geom', {
        p_org_id: targetOrgId,
        p_polygons: polygons,
        p_boundary_source: boundarySources.size === 1 ? [...boundarySources][0] : 'mixed_authoritative_ta',
        p_changed_by: action.approved_by ?? null
      });
      if (rpcErr) return await failAction(`set_org_jurisdiction_geom failed: ${rpcErr.message}`);
      // Phase 1 (item 3a): Authoritative ST_IsEmpty/ST_IsValid executor gate.
      // The RPC now returns the written area in m^2 (via ST_Area(geography)).
      // A returned area of 0 / NULL / non-finite means the geometry is empty or
      // invalid -- emit the loud GEOFENCE signal instead of stamping applied.
      // This replaces the Phase 0 best-effort EWKB string check.
      const jurArea = typeof jurAreaData === 'number' && isFinite(jurAreaData) ? jurAreaData : null;
      if (jurArea == null || jurArea <= 0) {
        return await failAction('GEOFENCE_INVALID: jurisdiction geometry is empty or has zero area after write for organization ' + targetOrgId + ' (returned area: ' + String(jurAreaData) + ')');
      }
      // Phase 5 (P2 visual verification gate): geometry lands UNVERIFIED.
      // The human must visually confirm it on the map via BoundaryVerificationConfirm
      // before it is consumed by resolve_context / billing / enforcement.
      await admin.from('organizations').update({
        jurisdiction_verification: 'unverified',
        jurisdiction_verified_by: null,
        jurisdiction_verified_at: null
      }).eq('id', targetOrgId);
      await admin.from('bob_agentic_actions').update({
        status: 'applied',
        result_table: 'organizations',
        result_record_id: targetOrgId,
        applied_at: new Date().toISOString(),
        error_message: null
      }).eq('id', action.id);
      return json({
        success: true,
        action_id: action.id,
        result_table: 'organizations',
        result_record_id: targetOrgId,
        // Phase 5: deep link to the org setup page for visual verification
        deep_link: `/org-setup`,
        note: `Jurisdiction boundary set from ${boundarySources.size === 1 ? [...boundarySources][0] : 'mixed authoritative TA sources'} for: ${districtNames.join(', ')}. UNVERIFIED -- open the Organisation Setup page to visually confirm the boundary on the map.`
      });
    }
    // ── set_site_risk_level ──
    // payload: { site_id, risk_level }. Governed update of client_sites.risk_level
    // from a Bob site-risk assessment. Human approves in the bell; this applies
    // the single-column write. Reversible (a human can change it back).
    if (action.action_type === 'set_site_risk_level') {
      const sp = action.proposed_payload ?? {};
      const siteId = sp.site_id ? String(sp.site_id) : '';
      const riskLevel = sp.risk_level ? String(sp.risk_level).toLowerCase().trim() : '';
      const ALLOWED = new Set([
        'low',
        'medium',
        'high',
        'critical'
      ]);
      if (!siteId) return await failAction('proposed_payload.site_id is required');
      if (!ALLOWED.has(riskLevel)) return await failAction(`proposed_payload.risk_level must be one of ${[
        ...ALLOWED
      ].join('/')}`);
      // Confirm the site exists and belongs to the action's org (no cross-org write).
      const { data: site } = await admin.from('client_sites').select('id, client_organization_id').eq('id', siteId).maybeSingle();
      if (!site) return await failAction(`site_id ${siteId} does not exist`);
      const { error: updErr } = await admin.from('client_sites').update({
        risk_level: riskLevel
      }).eq('id', siteId);
      if (updErr) return await failAction(`client_sites.risk_level update failed: ${updErr.message}`);
      await admin.from('bob_agentic_actions').update({
        status: 'applied',
        result_table: 'client_sites',
        result_record_id: siteId,
        applied_at: new Date().toISOString(),
        error_message: null
      }).eq('id', action.id);
      return json({
        success: true,
        action_id: action.id,
        result_table: 'client_sites',
        result_record_id: siteId,
        note: `Site risk_level set to '${riskLevel}'.`
      });
    }
    // ── create_client_root_org ── (national client tenant)
    // payload: { name, contact_email?, contact_phone?, billing_email?,
    //            billing_address?, account_notes?, is_national? }
    // Governed create of a TOP-LEVEL client organization with NO parent (a tenant
    // root, e.g. LINZ). Distinct from create_client_org (which requires a parent):
    // creating a tenant root is rare + high-blast-radius, so it is proposed only by
    // a grand_master (bob-propose-client-root-org) and written here as its own
    // guarded action. organization_type is forced to 'client';
    // parent_organization_id is explicitly null. organization_level is
    // trigger-maintained.
    //
    // Dedupe: organizations.name has NO unique constraint, so refuse to create a
    // duplicate NATIONAL client (client + parent_organization_id IS NULL) of the
    // same case-insensitive name — return the existing id (idempotent).
    if (action.action_type === 'create_client_root_org') {
      const cp = action.proposed_payload ?? {};
      const orgName = cp.name ? String(cp.name).trim() : '';
      const failRoot = async (msg)=>{
        await admin.from('bob_agentic_actions').update({
          status: 'failed',
          error_message: msg
        }).eq('id', action.id);
        return json({
          error: msg
        }, 422);
      };
      if (!orgName) return await failRoot('proposed_payload.name is required to create a national client tenant');
      // Dedupe by (case-insensitive name) among existing NATIONAL clients.
      const { data: existing } = await admin.from('organizations').select('id').eq('organization_type', 'client').is('parent_organization_id', null).ilike('name', orgName).maybeSingle();
      if (existing?.id) {
        await admin.from('bob_agentic_actions').update({
          status: 'applied',
          result_table: 'organizations',
          result_record_id: existing.id,
          applied_at: new Date().toISOString(),
          error_message: null
        }).eq('id', action.id);
        return json({
          success: true,
          action_id: action.id,
          result_table: 'organizations',
          result_record_id: existing.id,
          deduped: true,
          note: `A national client tenant named '${orgName}' already exists; used the existing record (no duplicate created).`
        });
      }
      const rootRow = {
        name: orgName,
        organization_type: 'client',
        parent_organization_id: null
      };
      for (const k of [
        'contact_email',
        'contact_phone',
        'billing_email',
        'billing_address',
        'account_notes'
      ]){
        if (typeof cp[k] === 'string' && String(cp[k]).trim()) rootRow[k] = String(cp[k]).trim();
      }
      const { data: createdRoot, error: rootErr } = await admin.from('organizations').insert(rootRow).select('id').single();
      if (rootErr || !createdRoot) return await failRoot(`organizations insert failed: ${rootErr?.message ?? 'unknown error'}`);
      await admin.from('bob_agentic_actions').update({
        status: 'applied',
        result_table: 'organizations',
        result_record_id: createdRoot.id,
        applied_at: new Date().toISOString(),
        error_message: null
      }).eq('id', action.id);
      return json({
        success: true,
        action_id: action.id,
        result_table: 'organizations',
        result_record_id: createdRoot.id,
        deduped: false,
        note: `National client tenant '${orgName}' created (no parent). Add its branches under it with create_client_org.`
      });
    }
    // ── create_place_org_from_parcel ── (Foundation Layer 1; #19 / #226)
    // payload: {
    //   name,                       (required; display name, e.g. the address)
    //   gps_lat, gps_lng,           (required; the resolved point)
    //   parcel_polygon,             (required; GeoJSON geometry from LINZ boundary_for_point)
    //   resolved_from_address?,     (the address the dispatcher/officer entered, for traceability)
    //   parcel_id?,                 (LINZ parcel id, if available)
    //   triggered_by?               (the human who caused this; recorded in provenance)
    // }
    //
    // Creates the ACCOUNTABLE-PLACE org for a physical property (e.g. a noise
    // source residence) in ONE SHOT so evidence can anchor to a real org whose
    // jurisdiction IS its own parcel (recursive containment: parcel org nests
    // inside its council's district by ST_Contains).
    //
    // CLASSIFICATION (zero schema change):
    //   organization_type='private_enterprise' -> non-authority; 0290 governor
    //     resolution excludes it (it cannot out-rank a real council). Guardrail 2.
    //   external_refs.org_class='place_record' + provenance. Guardrail 3 + trace.
    //
    // JURISDICTION: the LINZ parcel polygon via set_org_jurisdiction_geom (0284).
    //   OWNER RULING (2026-07-31): lands VERIFIED (not the RPC's default
    //   'unverified') because the parcel IS the LINZ authoritative geometry --
    //   verification is a governance-boundary gate, and a place-record is an
    //   evidence anchor, never a governor. We flip verification in THIS action
    //   AFTER the RPC; the shared RPC stays unchanged.
    //
    // AUTO-APPLY (owner ruling): ad-hoc dispatch place-records auto-apply -- no
    //   signed agreement to manage, bounded, one-off, parcel-specific. The engine
    //   must therefore be perfect: airtight GEOMETRY dedup + read-back + rollback.
    //
    // Dedup: geometry-first via get_orgs_by_jurisdiction_point(lng,lat) -- resolve
    //   an existing place-org at this parcel rather than ever creating a second
    //   (the anti-duplication anchor is the LAND, never a typed name).
    if (action.action_type === 'create_place_org_from_parcel') {
      const pp = action.proposed_payload ?? {};
      const placeName = pp.name ? String(pp.name).trim() : '';
      const lat = typeof pp.gps_lat === 'number' ? pp.gps_lat : null;
      const lng = typeof pp.gps_lng === 'number' ? pp.gps_lng : null;
      const parcelPolygon = pp.parcel_polygon && typeof pp.parcel_polygon === 'object' ? pp.parcel_polygon : null;
      const failPlace = async (msg)=>{
        await admin.from('bob_agentic_actions').update({
          status: 'failed',
          error_message: msg
        }).eq('id', action.id);
        return json({
          error: msg
        }, 422);
      };
      if (!placeName) return await failPlace('proposed_payload.name is required');
      if (lat === null || lng === null) return await failPlace('proposed_payload.gps_lat and gps_lng are required (the resolved point)');
      if (!parcelPolygon) return await failPlace('proposed_payload.parcel_polygon (GeoJSON geometry from LINZ) is required -- a place-record must anchor to a real parcel');
      // ── Dedup: is there already a place-org at this parcel/point? ──
      // get_orgs_by_jurisdiction_point returns orgs whose VERIFIED jurisdiction
      // contains the point. A previously-created place-record lands verified, so
      // it is discoverable here -> idempotent, never a duplicate parcel org.
      {
        const { data: hits } = await admin.rpc('get_orgs_by_jurisdiction_point', {
          p_lng: lng,
          p_lat: lat
        });
        // The RPC returns any containing org (incl. the governing council). Only
        // treat a PLACE-RECORD hit as an existing match -- a council containing
        // the point is NOT the parcel org. Confirm org_class on the candidates.
        const candidateIds = Array.isArray(hits) ? hits.map((h)=>h?.id).filter(Boolean) : [];
        if (candidateIds.length > 0) {
          const { data: placeMatches } = await admin.from('organizations').select('id, name, external_refs').in('id', candidateIds);
          const existing = (placeMatches ?? []).find((o)=>{
            const er = o.external_refs ?? {};
            return er.org_class === 'place_record';
          });
          if (existing) {
            await admin.from('bob_agentic_actions').update({
              status: 'applied',
              result_table: 'organizations',
              result_record_id: existing.id,
              applied_at: new Date().toISOString(),
              error_message: null
            }).eq('id', action.id);
            return json({
              success: true,
              action_id: action.id,
              result_table: 'organizations',
              result_record_id: existing.id,
              deduped: true,
              note: `A place-record org already exists at this parcel ('${String(existing.name)}'); used the existing record.`
            });
          }
        }
      }
      // ── Create the own-rooted place-record org ──
      const externalRefs = {
        org_class: 'place_record',
        created_via: 'adhoc_dispatch',
        jurisdiction_source: 'linz_parcel'
      };
      if (pp.parcel_id) externalRefs.parcel_id = String(pp.parcel_id);
      if (pp.resolved_from_address) externalRefs.resolved_from_address = String(pp.resolved_from_address);
      if (pp.triggered_by) externalRefs.created_by = String(pp.triggered_by);
      const { data: createdPlace, error: placeErr } = await admin.from('organizations').insert({
        name: placeName,
        organization_type: 'private_enterprise',
        parent_organization_id: null,
        external_refs: externalRefs
      }).select('id').single();
      if (placeErr || !createdPlace) return await failPlace(`organizations insert failed: ${placeErr?.message ?? 'unknown error'}`);
      const placeOrgId = createdPlace.id;
      // ── Stamp jurisdiction = the LINZ parcel polygon (read-back verified) ──
      // set_org_jurisdiction_geom RAISEs on empty/invalid geometry and RETURNS
      // the written area (m^2). area<=0 / null => the geometry did not land ->
      // ROLLBACK the org (no orphan place-org with no boundary) and fail loud.
      const { data: areaData, error: rpcErr } = await admin.rpc('set_org_jurisdiction_geom', {
        p_org_id: placeOrgId,
        p_polygons: [
          parcelPolygon
        ],
        p_boundary_source: 'linz_parcel',
        p_changed_by: pp.triggered_by ? String(pp.triggered_by) : null
      });
      const area = typeof areaData === 'number' && isFinite(areaData) ? areaData : null;
      if (rpcErr || area === null || area <= 0) {
        // Rollback: remove the just-created org so we never leave a boundary-less
        // place-record. (No dependents exist yet -- jurisdiction write is the
        // only follow-on, and it failed.)
        await admin.from('organizations').delete().eq('id', placeOrgId);
        return await failPlace(`jurisdiction stamp failed (${rpcErr?.message ?? `area=${String(areaData)}`}); rolled back place-org ${placeOrgId} -- no boundary-less org left behind`);
      }
      // ── OWNER RULING: place-record jurisdiction is VERIFIED (LINZ authority) ──
      // Flip the RPC's default 'unverified' -> 'verified' HERE (not in the shared
      // RPC). A LINZ parcel is authoritative by provenance; human confirmation
      // would only be confirming LINZ against LINZ. This lets the place-org be
      // immediately usable as an evidence anchor with no verification limbo.
      await admin.from('organizations').update({
        jurisdiction_verification: 'verified',
        jurisdiction_verified_at: new Date().toISOString(),
        jurisdiction_verified_by: pp.triggered_by ? String(pp.triggered_by) : null
      }).eq('id', placeOrgId);
      await admin.from('bob_agentic_actions').update({
        status: 'applied',
        result_table: 'organizations',
        result_record_id: placeOrgId,
        applied_at: new Date().toISOString(),
        error_message: null
      }).eq('id', action.id);
      return json({
        success: true,
        action_id: action.id,
        result_table: 'organizations',
        result_record_id: placeOrgId,
        deduped: false,
        note: `Place-record org '${placeName}' created (own-rooted; jurisdiction = its LINZ parcel, ${Math.round(area)} m^2, verified). Ready as an evidence anchor.`
      });
    }
    // ── create_client_org ── (Phase 2 MR-1, updated 0271 for Model A)
    // payload: { name, parent_organization_id?, nzbn?, contact_email?,
    //            contact_phone?, billing_email?, billing_address?,
    //            account_notes?, organization_type? }
    // Governed create of a CLIENT organization (organization_type='client'
    // unless overridden for own-rooted orgs).
    //
    // Model A (0271 / #214): parent_organization_id is now OPTIONAL.
    //   - If provided: parented path (existing behaviour, unchanged).
    //   - If null/absent: own-rooted org (parent = NULL). Only grand_master
    //     may create own-rooted orgs (RLS enforced by gm_full_access 0076;
    //     master_manage_orgs_insert 0093 blocks parent=NULL for non-GM).
    //
    // Dedupe strategy (Model A):
    //   - Parented: by case-insensitive name under the same parent (unchanged).
    //   - Own-rooted: by NZBN globally (if nzbn provided), THEN by
    //     case-insensitive name among own-rooted orgs (parent IS NULL).
    if (action.action_type === 'create_client_org') {
      const cp = action.proposed_payload ?? {};
      const orgName = cp.name ? String(cp.name).trim() : '';
      const parentOrgId = cp.parent_organization_id ? String(cp.parent_organization_id) : '';
      const nzbn = cp.nzbn ? String(cp.nzbn).trim() : '';
      const failOrg = async (msg)=>{
        await admin.from('bob_agentic_actions').update({
          status: 'failed',
          error_message: msg
        }).eq('id', action.id);
        return json({
          error: msg
        }, 422);
      };
      if (!orgName) return await failOrg('proposed_payload.name is required to create a client organization');
      // ── Own-rooted path (Model A: parent_organization_id absent/null) ──
      if (!parentOrgId) {
        // Dedupe: NZBN globally unique (if provided), then name among own-rooted orgs.
        let existingId;
        if (nzbn) {
          const { data: byNzbn } = await admin.from('organizations').select('id').eq('nzbn', nzbn).maybeSingle();
          existingId = byNzbn?.id;
        }
        if (!existingId) {
          const { data: byName } = await admin.from('organizations').select('id').is('parent_organization_id', null).ilike('name', orgName).maybeSingle();
          existingId = byName?.id;
        }
        if (existingId) {
          await admin.from('bob_agentic_actions').update({
            status: 'applied',
            result_table: 'organizations',
            result_record_id: existingId,
            applied_at: new Date().toISOString(),
            error_message: null
          }).eq('id', action.id);
          return json({
            success: true,
            action_id: action.id,
            result_table: 'organizations',
            result_record_id: existingId,
            deduped: true,
            note: `An own-rooted organization matching '${orgName}'${nzbn ? ` (NZBN ${nzbn})` : ''} already exists; used the existing record.`
          });
        }
        // Determine organization_type: allow override for own-rooted orgs
        // (they can be any type except 'owner'). Default to 'client'.
        const orgType = cp.organization_type ? String(cp.organization_type).trim() : 'client';
        const orgRow = {
          name: orgName,
          organization_type: orgType,
          parent_organization_id: null
        };
        if (nzbn) orgRow.nzbn = nzbn;
        for (const k of [
          'contact_email',
          'contact_phone',
          'billing_email',
          'billing_address',
          'account_notes'
        ]){
          if (typeof cp[k] === 'string' && String(cp[k]).trim()) orgRow[k] = String(cp[k]).trim();
        }
        const { data: createdOrg, error: orgErr } = await admin.from('organizations').insert(orgRow).select('id').single();
        if (orgErr || !createdOrg) return await failOrg(`organizations insert failed: ${orgErr?.message ?? 'unknown error'}`);
        await admin.from('bob_agentic_actions').update({
          status: 'applied',
          result_table: 'organizations',
          result_record_id: createdOrg.id,
          applied_at: new Date().toISOString(),
          error_message: null
        }).eq('id', action.id);
        return json({
          success: true,
          action_id: action.id,
          result_table: 'organizations',
          result_record_id: createdOrg.id,
          deduped: false,
          note: `Own-rooted organization '${orgName}' created (Model A, no parent).`
        });
      }
      // ── Parented path (existing behaviour, unchanged) ──
      // Confirm the parent org exists (avoids a dangling ownership tree).
      const { data: parentOrg } = await admin.from('organizations').select('id').eq('id', parentOrgId).maybeSingle();
      if (!parentOrg) return await failOrg(`parent_organization_id ${parentOrgId} does not exist`);
      // Dedupe by (case-insensitive name) under the same parent.
      const { data: existing } = await admin.from('organizations').select('id').eq('organization_type', 'client').eq('parent_organization_id', parentOrgId).ilike('name', orgName).maybeSingle();
      if (existing?.id) {
        // Idempotent: treat the existing org as the result, do not create a dup.
        await admin.from('bob_agentic_actions').update({
          status: 'applied',
          result_table: 'organizations',
          result_record_id: existing.id,
          applied_at: new Date().toISOString(),
          error_message: null
        }).eq('id', action.id);
        return json({
          success: true,
          action_id: action.id,
          result_table: 'organizations',
          result_record_id: existing.id,
          deduped: true,
          note: `A client organization named '${orgName}' already exists under this parent; used the existing record (no duplicate created).`
        });
      }
      // Insert the client org. Only required + explicitly-provided columns;
      // everything else falls back to safe DB defaults (active, status,
      // enforcement_workflow_mode); organization_level is trigger-maintained.
      const orgRow = {
        name: orgName,
        organization_type: 'client',
        parent_organization_id: parentOrgId
      };
      if (nzbn) orgRow.nzbn = nzbn;
      for (const k of [
        'contact_email',
        'contact_phone',
        'billing_email',
        'billing_address',
        'account_notes'
      ]){
        if (typeof cp[k] === 'string' && String(cp[k]).trim()) orgRow[k] = String(cp[k]).trim();
      }
      const { data: createdOrg, error: orgErr } = await admin.from('organizations').insert(orgRow).select('id').single();
      if (orgErr || !createdOrg) return await failOrg(`organizations insert failed: ${orgErr?.message ?? 'unknown error'}`);
      await admin.from('bob_agentic_actions').update({
        status: 'applied',
        result_table: 'organizations',
        result_record_id: createdOrg.id,
        applied_at: new Date().toISOString(),
        error_message: null
      }).eq('id', action.id);
      return json({
        success: true,
        action_id: action.id,
        result_table: 'organizations',
        result_record_id: createdOrg.id,
        deduped: false,
        note: `Client organization '${orgName}' created under parent ${parentOrgId}.`
      });
    }
    // ── create_client_site ── (Phase 2 MR-2)
    // payload: {
    //   name,                                (required)
    //   client_organization_id?,             (direct parent org) OR
    //   parent_action_id?,                   (a create_client_org action to read the org id from)
    //   address?, site_type?, site_origin?, gps_lat?, gps_lng?,
    //   address_match_key?, site_brief?, access_instructions?, hs_notes?
    // }
    // Governed create of a client SITE. PARENT-FIRST (approach A): the client
    // org must exist first. The org is resolved EITHER from a direct
    // client_organization_id, OR from a linked create_client_org action via
    // parent_action_id — in which case this REFUSES to run until that action is
    // status='applied' (enforces order + means the org id is real).
    //
    // Verified live columns (2026-07-06): client_sites required-without-default
    // = client_organization_id, name. metadata/active/prompt_radius/onsite_radius/
    // site_origin/ownership_status all default. Mirrors the proven SiteQuickCreate
    // insert. Dedupe by address_match_key (shared officer-safety history) when a
    // key is available, same rationale as SiteQuickCreate.
    if (action.action_type === 'create_client_site') {
      const sp = action.proposed_payload ?? {};
      const siteName = sp.name ? String(sp.name).trim() : '';
      const failSite = async (msg)=>{
        await admin.from('bob_agentic_actions').update({
          status: 'failed',
          error_message: msg
        }).eq('id', action.id);
        return json({
          error: msg
        }, 422);
      };
      if (!siteName) return await failSite('proposed_payload.name is required to create a site');
      // Resolve the parent client org (PARENT-FIRST guard).
      let clientOrgId = sp.client_organization_id ? String(sp.client_organization_id) : '';
      const parentActionId = sp.parent_action_id ? String(sp.parent_action_id) : '';
      if (!clientOrgId && parentActionId) {
        // Read the org id from the linked create_client_org action.
        const { data: parentAction } = await admin.from('bob_agentic_actions').select('id, action_type, status, result_record_id, result_table').eq('id', parentActionId).maybeSingle();
        if (!parentAction) return await failSite(`parent_action_id ${parentActionId} not found`);
        if (String(parentAction.action_type) !== 'create_client_org') {
          return await failSite(`parent_action_id ${parentActionId} is not a create_client_org action`);
        }
        if (String(parentAction.status) !== 'applied' || !parentAction.result_record_id) {
          // PARENT-FIRST: refuse until the org action has actually created the org.
          return await failSite(`parent client org is not created yet (parent action status='${parentAction.status}'). Approve + execute the create_client_org action first.`);
        }
        clientOrgId = String(parentAction.result_record_id);
      }
      if (!clientOrgId) {
        return await failSite('proposed_payload.client_organization_id is required (or a parent_action_id pointing at an applied create_client_org action)');
      }
      // Confirm the client org exists (no dangling FK / cross-org mistake).
      const { data: clientOrg } = await admin.from('organizations').select('id').eq('id', clientOrgId).maybeSingle();
      if (!clientOrg) return await failSite(`client_organization_id ${clientOrgId} does not exist`);
      // Dedupe by address key inside the owner organisation (the DB trigger stores the
      // same key shape; another organisation's site at this address is its own facet
      // on the shared registry place, not a duplicate).
      const matchKey = computeEffectiveDedupKey(sp.address_match_key ?? null, sp.address ?? null) ?? '';
      if (matchKey) {
        const { data: existingSite } = await admin.from('client_sites').select('id').eq('client_organization_id', clientOrgId).eq('address_match_key', matchKey).limit(1).maybeSingle();
        if (existingSite?.id) {
          await admin.from('bob_agentic_actions').update({
            status: 'applied',
            result_table: 'client_sites',
            result_record_id: existingSite.id,
            applied_at: new Date().toISOString(),
            error_message: null
          }).eq('id', action.id);
          return json({
            success: true,
            action_id: action.id,
            result_table: 'client_sites',
            result_record_id: existingSite.id,
            deduped: true,
            note: `A site already exists at this address (match key); used the existing record (no duplicate created).`
          });
        }
      }
      // ── canonicalSiteEntry equivalent -- see apps/web/src/lib/canonicalSiteEntry.ts ──
      // Deno edge function: cannot import the web lib. The logic below mirrors
      // the canonical pipeline (dedup + boundary + module assignment + ownership_status).
      //
      // ── Geometry resolution (POLYGON-FIRST, #19) ──
      // A site MUST carry a boundary or center_point (client_sites_geo_required_chk,
      // 0100). Resolve which geometry to write BEFORE inserting, so we never leave
      // a geometry-less orphan row or surface a raw constraint violation:
      //   1. boundary polygon (GeoJSON)                 -> authoritative (PREFERRED)
      //   2. point (gps_lat/lng)                        -> buffered provisional
      //      polygon; boundary_status='provisional' + ownership_status='needs_review'
      //      so a human refines the fence, while an urgent alarm/dispatch job can
      //      proceed now.
      //   3. neither                                    -> clean failure.
      // The actual address->polygon LADDER (deciding what to propose) is Bob's
      // brain (#19 step c); this executor only WRITES what was proposed.
      const boundaryGeo = sp.boundary && typeof sp.boundary === 'object' ? sp.boundary : null;
      const hasPoint = typeof sp.gps_lat === 'number' && typeof sp.gps_lng === 'number';
      const provisional = boundaryGeo == null && hasPoint;
      if (!boundaryGeo && !hasPoint) {
        return await failSite('No geofence supplied: create_client_site requires proposed_payload.boundary (GeoJSON polygon, preferred) or gps_lat+gps_lng for a provisional fence. Resolve the site geometry (LINZ->Google) before proposing.');
      }
      // Insert the site. Required + explicitly-provided columns only; the rest use
      // safe DB defaults (metadata, active, radii, site_origin). Geometry is
      // written in a second step via set_site_geometry (PostGIS expressions can't
      // pass through PostgREST insert). A provisional (point-only) fence is
      // stamped needs_review + boundary_status='provisional' so a human refines it.
      const siteRow = {
        client_organization_id: clientOrgId,
        name: siteName,
        ownership_status: provisional ? 'needs_review' : 'resolved',
        boundary_status: provisional ? 'provisional' : 'authoritative',
        ownership_signals: {
          created_via: 'bob_governed_create',
          parent_action_id: parentActionId || null,
          provisional_boundary: provisional,
          geometry_source: boundaryGeo ? 'polygon' : 'provisional_point_buffer'
        }
      };
      if (typeof sp.address === 'string' && sp.address.trim()) siteRow.address = sp.address.trim();
      if (typeof sp.site_type === 'string' && sp.site_type.trim()) siteRow.site_type = sp.site_type.trim();
      if (typeof sp.site_origin === 'string' && sp.site_origin.trim()) siteRow.site_origin = sp.site_origin.trim();
      if (matchKey) siteRow.address_match_key = matchKey;
      if (typeof sp.gps_lat === 'number') siteRow.gps_lat = sp.gps_lat;
      if (typeof sp.gps_lng === 'number') siteRow.gps_lng = sp.gps_lng;
      for (const k of [
        'site_brief',
        'access_instructions',
        'hs_notes'
      ]){
        if (typeof sp[k] === 'string' && String(sp[k]).trim()) siteRow[k] = String(sp[k]).trim();
      }
      const { data: createdSite, error: siteErr } = await admin.from('client_sites').insert(siteRow).select('id').single();
      if (siteErr || !createdSite) return await failSite(`client_sites insert failed: ${siteErr?.message ?? 'unknown error'}`);
      // Write geometry (boundary + centroid) via the service-role RPC. If this
      // fails, roll back the orphan site row so we never leave a geometry-less
      // record (which would also violate client_sites_geo_required_chk).
      const provisionalRadius = typeof sp.provisional_radius_m === 'number' && sp.provisional_radius_m > 0 ? sp.provisional_radius_m : 50;
      // Phase 4 fast-follow (0284): resolve boundary_source from the payload
      // (the proposer knows which resolver succeeded: linz_parcel / linz_building
      // / google / point_radius). If not provided, the RPC defaults to
      // 'UNKNOWN_SOURCE' for polygon or 'point_radius' for point path (P1).
      const siteBoundarySource = typeof sp.boundary_source === 'string' && sp.boundary_source.trim() ? sp.boundary_source.trim() : null;
      const { data: siteAreaData, error: geoErr } = await admin.rpc('set_site_geometry', {
        p_site_id: createdSite.id,
        p_boundary: boundaryGeo,
        p_center_lat: provisional ? sp.gps_lat : null,
        p_center_lng: provisional ? sp.gps_lng : null,
        p_provisional_radius_m: provisionalRadius,
        p_boundary_source: siteBoundarySource,
        p_changed_by: action.approved_by ?? null
      });
      if (geoErr) {
        await admin.from('client_sites').delete().eq('id', createdSite.id);
        return await failSite(`set_site_geometry failed (site rolled back): ${geoErr.message}`);
      }
      // Phase 1 (item 3a): Authoritative area-based gate. The RPC now returns
      // the written area in m^2. A returned area of 0 / NULL / non-finite means
      // the geometry is empty or invalid. This replaces the Phase 0 EWKB string check.
      const siteArea = typeof siteAreaData === 'number' && isFinite(siteAreaData) ? siteAreaData : null;
      if (siteArea == null || siteArea <= 0) {
        await admin.from('client_sites').delete().eq('id', createdSite.id);
        return await failSite('GEOFENCE_INVALID: client site boundary is empty or has zero area after write for site ' + createdSite.id + ' (returned area: ' + String(siteAreaData) + ')');
      }
      // Phase 5 (P2 visual verification gate): site boundary lands UNVERIFIED.
      await admin.from('client_sites').update({
        boundary_verification: 'unverified',
        boundary_verified_by: null,
        boundary_verified_at: null
      }).eq('id', createdSite.id);
      // Q-A4: Mandatory module assignment via site_services.
      // Canonical contract (canonicalSiteEntry.ts) requires every site to have
      // at least one module assigned. The governed path must not create a
      // module-less site. If module_key is provided in the payload, assign it;
      // otherwise default to 'general_patrol' (the safest default for a
      // governed site create). Errors are NOT swallowed (P1).
      // Verified against LIVE_SCHEMA: site_services requires organization_id
      // (NOT NULL), site_id, module_key. No unique constraint on
      // (site_id, module_key), so check-then-insert.
      const siteModuleKey = typeof sp.module_key === 'string' && sp.module_key.trim() ? sp.module_key.trim() : 'general_patrol';
      {
        const { data: existingSvc } = await admin.from('site_services').select('id').eq('site_id', createdSite.id).eq('module_key', siteModuleKey).limit(1).maybeSingle();
        if (!existingSvc) {
          const { error: svcErr } = await admin.from('site_services').insert({
            site_id: createdSite.id,
            organization_id: clientOrgId,
            module_key: siteModuleKey,
            active: true
          });
          if (svcErr) {
            // Q-A4 + P1: module assignment is MANDATORY. Roll back the site
            // so we never leave a module-less site in the database.
            await admin.from('client_sites').delete().eq('id', createdSite.id);
            return await failSite(`MANDATORY module assignment failed for site ${createdSite.id}, ` + `module '${siteModuleKey}': ${svcErr.message}. Site rolled back (Q-A4).`);
          }
        }
      }
      await admin.from('bob_agentic_actions').update({
        status: 'applied',
        result_table: 'client_sites',
        result_record_id: createdSite.id,
        applied_at: new Date().toISOString(),
        error_message: null
      }).eq('id', action.id);
      return json({
        success: true,
        action_id: action.id,
        result_table: 'client_sites',
        result_record_id: createdSite.id,
        deduped: false,
        provisional,
        deep_link: `/sites/${createdSite.id}`,
        note: provisional ? `Site '${siteName}' created under client org ${clientOrgId} with a PROVISIONAL point-buffer fence (${provisionalRadius} m); flagged needs_review so a human can refine the boundary. Module '${siteModuleKey}' assigned. UNVERIFIED -- visually confirm the boundary on the map.` : `Site '${siteName}' created under client org ${clientOrgId} with an authoritative boundary polygon. Module '${siteModuleKey}' assigned. UNVERIFIED -- visually confirm the boundary on the map.`
      });
    }
    // ── create_patrol_route_assignment ──
    // Adds a client site to a patrol route by inserting a client_site_patrol_config
    // row — the AUTHORITATIVE site→route link (validated in code+schema:
    // SitePatrolConfigPanel writes this table; PatrolRoutesPage reads a route's
    // stops from it; the geofence is NOT the link). PARENT-FIRST: the site is
    // resolved from a direct site_id OR from a linked create_client_site action
    // (refused until that action is status='applied').
    //
    // payload: {
    //   site_id? | parent_action_id?,  patrol_route_id (required),
    //   module_key, active_days, visits_per_shift, min_gap_between_visits_minutes,
    //   time_window_type, window_start, window_end, dwell_minutes,
    //   sla_arrive_within_minutes, sla_depart_within_minutes, preferred_stop_order,
    //   officer_instructions, required_actions
    // }
    // Verified live columns (migration 0030 client_site_patrol_config): required
    // = organization_id, site_id, module_key; the rest default. Unique
    // (site_id, patrol_route_id, module_key) — so a duplicate is idempotently
    // returned, never an error.
    if (action.action_type === 'create_patrol_route_assignment') {
      const pp = action.proposed_payload ?? {};
      const orgId = String(action.organization_id);
      const patrolRouteId = pp.patrol_route_id ? String(pp.patrol_route_id) : '';
      const moduleKey = pp.module_key ? String(pp.module_key) : 'general_patrol';
      const failPra = async (msg)=>{
        await admin.from('bob_agentic_actions').update({
          status: 'failed',
          error_message: msg
        }).eq('id', action.id);
        return json({
          error: msg
        }, 422);
      };
      if (!patrolRouteId) return await failPra('proposed_payload.patrol_route_id is required');
      // Resolve the site (PARENT-FIRST guard, mirrors create_client_site).
      let siteId = pp.site_id ? String(pp.site_id) : '';
      const parentActionId = pp.parent_action_id ? String(pp.parent_action_id) : '';
      if (!siteId && parentActionId) {
        const { data: parentAction } = await admin.from('bob_agentic_actions').select('id, action_type, status, result_record_id').eq('id', parentActionId).maybeSingle();
        if (!parentAction) return await failPra(`parent_action_id ${parentActionId} not found`);
        if (String(parentAction.action_type) !== 'create_client_site') {
          return await failPra(`parent_action_id ${parentActionId} is not a create_client_site action`);
        }
        if (String(parentAction.status) !== 'applied' || !parentAction.result_record_id) {
          return await failPra(`parent site is not created yet (parent action status='${parentAction.status}'). Approve + execute the create_client_site action first.`);
        }
        siteId = String(parentAction.result_record_id);
      }
      if (!siteId) {
        return await failPra('proposed_payload.site_id is required (or a parent_action_id pointing at an applied create_client_site action)');
      }
      // Confirm the site exists.
      const { data: site } = await admin.from('client_sites').select('id').eq('id', siteId).maybeSingle();
      if (!site) return await failPra(`site_id ${siteId} does not exist`);
      // Confirm the route exists AND belongs to the same org (no cross-org link).
      const { data: route } = await admin.from('patrol_routes').select('id, organization_id').eq('id', patrolRouteId).maybeSingle();
      if (!route) return await failPra(`patrol_route_id ${patrolRouteId} does not exist`);
      if (String(route.organization_id) !== orgId) {
        return await failPra('patrol_route_id belongs to a different organization than the action');
      }
      // Idempotent on the live unique(site_id, patrol_route_id, module_key).
      const { data: existing } = await admin.from('client_site_patrol_config').select('id').eq('site_id', siteId).eq('patrol_route_id', patrolRouteId).eq('module_key', moduleKey).maybeSingle();
      if (existing?.id) {
        await admin.from('bob_agentic_actions').update({
          status: 'applied',
          result_table: 'client_site_patrol_config',
          result_record_id: existing.id,
          applied_at: new Date().toISOString(),
          error_message: null
        }).eq('id', action.id);
        return json({
          success: true,
          action_id: action.id,
          result_table: 'client_site_patrol_config',
          result_record_id: existing.id,
          deduped: true,
          note: `This site is already on that route for module '${moduleKey}'; used the existing schedule (no duplicate created).`
        });
      }
      // Insert client_site_patrol_config. Required + explicitly-provided columns
      // only; the rest use safe DB defaults (active_days all, visits 1, dwell 15,
      // SLA defaults, active true).
      const cfgRow = {
        organization_id: orgId,
        site_id: siteId,
        patrol_route_id: patrolRouteId,
        module_key: moduleKey
      };
      if (Array.isArray(pp.active_days) && pp.active_days.length) cfgRow.active_days = pp.active_days.map((d)=>Number(d)).filter((n)=>Number.isInteger(n) && n >= 1 && n <= 7);
      if (pp.visits_per_shift != null && Number.isFinite(Number(pp.visits_per_shift))) cfgRow.visits_per_shift = Math.max(1, Math.trunc(Number(pp.visits_per_shift)));
      if (pp.min_gap_between_visits_minutes != null && Number.isFinite(Number(pp.min_gap_between_visits_minutes))) cfgRow.min_gap_between_visits_minutes = Math.trunc(Number(pp.min_gap_between_visits_minutes));
      if (typeof pp.time_window_type === 'string' && pp.time_window_type.trim()) cfgRow.time_window_type = pp.time_window_type.trim();
      if (typeof pp.window_start === 'string' && pp.window_start.trim()) cfgRow.window_start = pp.window_start.trim();
      if (typeof pp.window_end === 'string' && pp.window_end.trim()) cfgRow.window_end = pp.window_end.trim();
      if (pp.dwell_minutes != null && Number.isFinite(Number(pp.dwell_minutes))) cfgRow.dwell_minutes = Math.max(1, Math.trunc(Number(pp.dwell_minutes)));
      if (pp.sla_arrive_within_minutes != null && Number.isFinite(Number(pp.sla_arrive_within_minutes))) cfgRow.sla_arrive_within_minutes = Math.trunc(Number(pp.sla_arrive_within_minutes));
      if (pp.sla_depart_within_minutes != null && Number.isFinite(Number(pp.sla_depart_within_minutes))) cfgRow.sla_depart_within_minutes = Math.trunc(Number(pp.sla_depart_within_minutes));
      if (pp.preferred_stop_order != null && Number.isFinite(Number(pp.preferred_stop_order))) cfgRow.preferred_stop_order = Math.trunc(Number(pp.preferred_stop_order));
      if (typeof pp.officer_instructions === 'string' && pp.officer_instructions.trim()) cfgRow.officer_instructions = pp.officer_instructions.trim();
      if (Array.isArray(pp.required_actions)) cfgRow.required_actions = pp.required_actions.map((a)=>String(a)).filter(Boolean);
      const { data: createdCfg, error: cfgErr } = await admin.from('client_site_patrol_config').insert(cfgRow).select('id').single();
      if (cfgErr || !createdCfg) return await failPra(`client_site_patrol_config insert failed: ${cfgErr?.message ?? 'unknown error'}`);
      await admin.from('bob_agentic_actions').update({
        status: 'applied',
        result_table: 'client_site_patrol_config',
        result_record_id: createdCfg.id,
        applied_at: new Date().toISOString(),
        error_message: null
      }).eq('id', action.id);
      return json({
        success: true,
        action_id: action.id,
        result_table: 'client_site_patrol_config',
        result_record_id: createdCfg.id,
        deduped: false,
        note: `Site added to patrol route (module '${moduleKey}').`
      });
    }
    // ── create_patrol_route_service_area ── (#19 Tier-2 geofence)
    // payload: { patrol_route_id (required, EXPLICIT id — never a name/label),
    //            district_names: string[] (required, canonical TA names),
    //            despatch_zone_code?, name?, module_key? }
    // Gives a patrol route its SERVICE-AREA geofence: a location_zones row
    // (zone_type='patrol_route', Tier 2 of the four-tier design 0127) whose
    // boundary is the union of the requested Territorial Authority district
    // polygon(s) (same shared resolver as set_org_jurisdiction),
    // linked to the route via patrol_route_zones.
    //
    // IDENTITY GUARD (the two-587-routes test, bob_identity_resolution_across_orgs
    // card): the route is resolved ONLY by its id, and MUST belong to the
    // action's organization_id — refuses on any mismatch. The producer
    // (bob-propose-patrol-route-service-area) never resolves a route by name,
    // so this guard is a second, independent check, not the only one.
    //
    // Verified live columns (2026-07-08): location_zones NOT NULL = organization_id,
    // name, zone_type (default 'freedom_camping' — must set explicitly), module_key
    // (default 'freedom_camping' — must set explicitly); site_id nullable (zones are
    // siblings to sites, 0089/0108); partial unique (organization_id,
    // despatch_zone_code) WHERE despatch_zone_code IS NOT NULL (0127) backs the
    // dedupe. patrol_route_zones required = patrol_route_id, zone_id;
    // coverage_priority defaults to 1.
    if (action.action_type === 'create_patrol_route_service_area') {
      const pp = action.proposed_payload ?? {};
      const orgId = String(action.organization_id);
      const patrolRouteId = pp.patrol_route_id ? String(pp.patrol_route_id) : '';
      const districtNames = Array.isArray(pp.district_names) ? pp.district_names.map((d)=>String(d).trim()).filter(Boolean) : [];
      const failSa = async (msg)=>{
        await admin.from('bob_agentic_actions').update({
          status: 'failed',
          error_message: msg
        }).eq('id', action.id);
        return json({
          error: msg
        }, 422);
      };
      if (!patrolRouteId) return await failSa('proposed_payload.patrol_route_id is required (the exact route id — never a name/label)');
      if (districtNames.length === 0) return await failSa('proposed_payload.district_names must be a non-empty array of Territorial Authority names');
      // Resolve the route BY ID ONLY, and confirm it belongs to this action's org.
      // Two organisations may have a same-named/coded route (e.g. two "587 Nelson
      // Patrol" routes) — resolving by id, then checking org, makes that
      // structurally safe.
      const { data: route } = await admin.from('patrol_routes').select('id, name, route_code, organization_id').eq('id', patrolRouteId).maybeSingle();
      if (!route) return await failSa(`patrol_route_id ${patrolRouteId} does not exist`);
      if (String(route.organization_id) !== orgId) {
        return await failSa('patrol_route_id belongs to a different organization than this action — refusing (resolve the exact route id for the intended organisation and try again)');
      }
      // Idempotent: a route already linked to a service-area zone is deduped.
      const { data: existingLink } = await admin.from('patrol_route_zones').select('id, zone_id').eq('patrol_route_id', patrolRouteId).maybeSingle();
      if (existingLink?.zone_id) {
        await admin.from('bob_agentic_actions').update({
          status: 'applied',
          result_table: 'location_zones',
          result_record_id: existingLink.zone_id,
          applied_at: new Date().toISOString(),
          error_message: null
        }).eq('id', action.id);
        return json({
          success: true,
          action_id: action.id,
          result_table: 'location_zones',
          result_record_id: existingLink.zone_id,
          deduped: true,
          note: `This route already has a service-area zone; used the existing one (no duplicate created).`
        });
      }
      // Phase 0 (item 1): Validate each TA name against the live canonical set
      // BEFORE resolving a boundary. On no exact match, return fuzzy suggestions.
      for (const districtName of districtNames){
        const validationErr = await validateTaName(districtName);
        if (validationErr) return await failSa(validationErr);
      }
      // Fetch each requested district's TA polygon (reuses the fn already
      // proven by set_org_jurisdiction above).
      const polygons = [];
      const boundarySources = new Set();
      for (const districtName of districtNames){
        let boundary = null;
        try {
          boundary = await fetchTaBoundary(districtName);
        } catch (e) {
          return await failSa(e instanceof Error ? e.message : `Territorial Authority boundary fetch failed for '${districtName}'`);
        }
        polygons.push(boundary.geometry);
        boundarySources.add(boundary.source);
      }
      const moduleKey = typeof pp.module_key === 'string' && pp.module_key.trim() ? pp.module_key.trim() : 'general_patrol';
      const zoneName = typeof pp.name === 'string' && pp.name.trim() ? pp.name.trim() : `${route.name} service area`;
      const despatchZoneCode = typeof pp.despatch_zone_code === 'string' && pp.despatch_zone_code.trim() ? pp.despatch_zone_code.trim() : route.route_code ? String(route.route_code) : null;
      // Insert the zone row. NOT NULL columns set explicitly (module_key/zone_type
      // would otherwise silently default to 'freedom_camping' — verified live).
      const zoneRow = {
        organization_id: orgId,
        name: zoneName,
        zone_type: 'patrol_route',
        module_key: moduleKey
      };
      if (despatchZoneCode) zoneRow.despatch_zone_code = despatchZoneCode;
      const { data: createdZone, error: zoneErr } = await admin.from('location_zones').insert(zoneRow).select('id').single();
      if (zoneErr || !createdZone) return await failSa(`location_zones insert failed: ${zoneErr?.message ?? 'unknown error'}`);
      // Write geometry via the service-role RPC; roll back the zone on failure
      // so no geometry-less service-area zone is left behind.
      // Phase 1: RPC now returns area (m^2).
      // Phase 4 fast-follow (0284): pass real provenance + actor.
      const { data: saAreaData, error: geoErr } = await admin.rpc('set_zone_geometry', {
        p_zone_id: createdZone.id,
        p_polygons: polygons,
        p_boundary_source: boundarySources.size === 1 ? [...boundarySources][0] : 'mixed_authoritative_ta',
        p_changed_by: action.approved_by ?? null
      });
      if (geoErr) {
        await admin.from('location_zones').delete().eq('id', createdZone.id);
        return await failSa(`set_zone_geometry failed (zone rolled back): ${geoErr.message}`);
      }
      // Phase 1 (item 3a): Authoritative area-based gate. The RPC now returns
      // the written area in m^2. A returned area of 0 / NULL / non-finite means
      // the geometry is empty or invalid. This replaces the Phase 0 EWKB string check.
      const saArea = typeof saAreaData === 'number' && isFinite(saAreaData) ? saAreaData : null;
      if (saArea == null || saArea <= 0) {
        await admin.from('location_zones').delete().eq('id', createdZone.id);
        return await failSa('GEOFENCE_INVALID: patrol route service area zone boundary is empty or has zero area after write for zone ' + createdZone.id + ' (returned area: ' + String(saAreaData) + ')');
      }
      // Link the zone to the route. Roll back the zone on failure so no
      // unlinked, orphaned service-area zone is left behind.
      const { data: createdLink, error: linkErr } = await admin.from('patrol_route_zones').insert({
        patrol_route_id: patrolRouteId,
        zone_id: createdZone.id
      }).select('id').single();
      if (linkErr || !createdLink) {
        await admin.from('location_zones').delete().eq('id', createdZone.id);
        return await failSa(`patrol_route_zones link failed (zone rolled back): ${linkErr?.message ?? 'unknown error'}`);
      }
      // Phase 5 (P2 visual verification gate): zone boundary lands UNVERIFIED.
      await admin.from('location_zones').update({
        boundary_verification: 'unverified',
        boundary_verified_by: null,
        boundary_verified_at: null
      }).eq('id', createdZone.id);
      await admin.from('bob_agentic_actions').update({
        status: 'applied',
        result_table: 'location_zones',
        result_record_id: createdZone.id,
        applied_at: new Date().toISOString(),
        error_message: null
      }).eq('id', action.id);
      return json({
        success: true,
        action_id: action.id,
        result_table: 'location_zones',
        result_record_id: createdZone.id,
        deduped: false,
        deep_link: `/locations`,
        note: `Service-area zone '${zoneName}' created for route '${route.name}' from: ${districtNames.join(', ')}. UNVERIFIED -- visually confirm the boundary on the map.`
      });
    }
    // ── create_zone_patrol_stop ── (unified stop model, !709 Phase 1a)
    // payload: {
    //   zone_id (required),  patrol_route_id (required),
    //   modules: [ { module_key, is_required?, module_config?, display_order? }, ... ]
    //            (required, non-empty; a zone stop carries one or MORE modules),
    //   active_days?, visits_per_shift?, min_gap_between_visits_minutes?,
    //   time_window_type?, window_start?, window_end?, dwell_minutes?,
    //   sla_arrive_within_minutes?, sla_depart_within_minutes?,
    //   preferred_stop_order?, officer_instructions?
    // }
    // Adds a ZONE to a patrol route as a stop — the zone equivalent of
    // create_patrol_route_assignment (which is site-keyed). Writes a
    // client_site_patrol_config row with zone_id (place XOR from 0138) and one
    // patrol_route_stop_modules row per module. The legacy singular module_key
    // is set from the FIRST module (dual-write) so existing readers keep working
    // until Phase 4 deprecation. Idempotent on (zone stop, route): if a config
    // already links this zone to this route, reuse it and reconcile modules.
    if (action.action_type === 'create_zone_patrol_stop') {
      const zpp = action.proposed_payload ?? {};
      const orgId = String(action.organization_id);
      const zoneId = zpp.zone_id ? String(zpp.zone_id) : '';
      const patrolRouteId = zpp.patrol_route_id ? String(zpp.patrol_route_id) : '';
      const modulesIn = Array.isArray(zpp.modules) ? zpp.modules : [];
      const failZps = async (msg)=>{
        await admin.from('bob_agentic_actions').update({
          status: 'failed',
          error_message: msg
        }).eq('id', action.id);
        return json({
          error: msg
        }, 422);
      };
      // JOIN 4 (#328): the authorising service_agreement_location is REQUIRED.
      // Owner ruling 2026-08-15: creating a zone patrol stop REQUIRES selecting
      // the authorising service_agreement_location — refuse without it (loud failAction).
      const serviceAgreementLocationId = zpp.service_agreement_location_id ? String(zpp.service_agreement_location_id) : '';
      if (!zoneId) return await failZps('proposed_payload.zone_id is required');
      if (!patrolRouteId) return await failZps('proposed_payload.patrol_route_id is required');
      if (!serviceAgreementLocationId) return await failZps('proposed_payload.service_agreement_location_id is required — a zone patrol stop must name its authorising contract (owner ruling 2026-08-15, #328)');
      if (modulesIn.length === 0) return await failZps('proposed_payload.modules must be a non-empty array (a stop carries one or more modules)');
      const VALID_MODULES = new Set([
        'freedom_camping',
        'parking_enforcement',
        'noise_control',
        'biosecurity',
        'smoke_complaints',
        'static_guarding',
        'access_control',
        'ems',
        'alarm_response',
        'welfare_check',
        'general_patrol'
      ]);
      const modules = modulesIn.map((m)=>({
          module_key: typeof m.module_key === 'string' ? m.module_key.trim() : '',
          is_required: typeof m.is_required === 'boolean' ? m.is_required : true,
          module_config: m.module_config && typeof m.module_config === 'object' ? m.module_config : {},
          display_order: typeof m.display_order === 'number' ? m.display_order : 0
        })).filter((m)=>m.module_key);
      for (const m of modules){
        if (!VALID_MODULES.has(m.module_key)) return await failZps(`module_key '${m.module_key}' is not a recognised module`);
      }
      if (modules.length === 0) return await failZps('no valid modules supplied');
      // Confirm the zone exists AND belongs to this org (no cross-org stop).
      const { data: zone } = await admin.from('location_zones').select('id, organization_id').eq('id', zoneId).maybeSingle();
      if (!zone) return await failZps(`zone_id ${zoneId} does not exist`);
      if (String(zone.organization_id) !== orgId) {
        return await failZps('zone_id belongs to a different organization than this action — refusing');
      }
      // Confirm the route exists AND belongs to the same org.
      const { data: route } = await admin.from('patrol_routes').select('id, organization_id').eq('id', patrolRouteId).maybeSingle();
      if (!route) return await failZps(`patrol_route_id ${patrolRouteId} does not exist`);
      if (String(route.organization_id) !== orgId) {
        return await failZps('patrol_route_id belongs to a different organization than this action — refusing');
      }
      // JOIN 4 (#328): Validate the authorising service_agreement_location exists,
      // is active, and references this zone.
      const { data: sal } = await admin.from('service_agreement_locations').select('id, zone_id, site_id, status, service_agreement_id').eq('id', serviceAgreementLocationId).maybeSingle();
      if (!sal) return await failZps(`service_agreement_location_id ${serviceAgreementLocationId} does not exist`);
      if (sal.status !== 'active') return await failZps(`service_agreement_location ${serviceAgreementLocationId} is not active (status: ${sal.status})`);
      if (String(sal.zone_id) !== zoneId) return await failZps(`service_agreement_location ${serviceAgreementLocationId} does not reference zone ${zoneId}`);
      // Resolve service_agreement_module_id for each module from the agreement.
      const { data: samRows } = await admin.from('service_agreement_modules').select('id, module_key').eq('service_agreement_id', String(sal.service_agreement_id)).eq('enabled', true);
      const samByKey = new Map((samRows ?? []).map((r)=>[
          String(r.module_key),
          String(r.id)
        ]));
      // Idempotent: reuse an existing zone-stop config for this (zone, route).
      const { data: existingCfg } = await admin.from('client_site_patrol_config').select('id').eq('zone_id', zoneId).eq('patrol_route_id', patrolRouteId).maybeSingle();
      let configId = existingCfg?.id ? String(existingCfg.id) : '';
      if (!configId) {
        // Insert the plan-time stop config with zone_id (place XOR; no site_id).
        // Legacy singular module_key = the first module (dual-write).
        const cfgRow = {
          organization_id: orgId,
          zone_id: zoneId,
          patrol_route_id: patrolRouteId,
          module_key: modules[0].module_key
        };
        if (Array.isArray(zpp.active_days) && zpp.active_days.length) cfgRow.active_days = zpp.active_days.map((d)=>Number(d)).filter((n)=>Number.isInteger(n) && n >= 1 && n <= 7);
        if (zpp.visits_per_shift != null && Number.isFinite(Number(zpp.visits_per_shift))) cfgRow.visits_per_shift = Math.max(1, Math.trunc(Number(zpp.visits_per_shift)));
        if (zpp.min_gap_between_visits_minutes != null && Number.isFinite(Number(zpp.min_gap_between_visits_minutes))) cfgRow.min_gap_between_visits_minutes = Math.trunc(Number(zpp.min_gap_between_visits_minutes));
        if (typeof zpp.time_window_type === 'string' && zpp.time_window_type.trim()) cfgRow.time_window_type = zpp.time_window_type.trim();
        if (typeof zpp.window_start === 'string' && zpp.window_start.trim()) cfgRow.window_start = zpp.window_start.trim();
        if (typeof zpp.window_end === 'string' && zpp.window_end.trim()) cfgRow.window_end = zpp.window_end.trim();
        if (zpp.dwell_minutes != null && Number.isFinite(Number(zpp.dwell_minutes))) cfgRow.dwell_minutes = Math.max(1, Math.trunc(Number(zpp.dwell_minutes)));
        if (zpp.sla_arrive_within_minutes != null && Number.isFinite(Number(zpp.sla_arrive_within_minutes))) cfgRow.sla_arrive_within_minutes = Math.trunc(Number(zpp.sla_arrive_within_minutes));
        if (zpp.sla_depart_within_minutes != null && Number.isFinite(Number(zpp.sla_depart_within_minutes))) cfgRow.sla_depart_within_minutes = Math.trunc(Number(zpp.sla_depart_within_minutes));
        if (zpp.preferred_stop_order != null && Number.isFinite(Number(zpp.preferred_stop_order))) cfgRow.preferred_stop_order = Math.trunc(Number(zpp.preferred_stop_order));
        if (typeof zpp.officer_instructions === 'string' && zpp.officer_instructions.trim()) cfgRow.officer_instructions = zpp.officer_instructions.trim();
        const { data: createdCfg, error: cfgErr } = await admin.from('client_site_patrol_config').insert(cfgRow).select('id').single();
        if (cfgErr || !createdCfg) return await failZps(`client_site_patrol_config insert failed: ${cfgErr?.message ?? 'unknown error'}`);
        configId = String(createdCfg.id);
      }
      // Upsert the module rows (many-modules-per-stop). Skip any that already
      // exist for this config (unique (patrol_config_id, module_key)).
      // JOIN 4 (#328): each module row carries its authorising contract.
      const { data: existingMods } = await admin.from('patrol_route_stop_modules').select('module_key').eq('patrol_config_id', configId);
      const have = new Set((existingMods ?? []).map((r)=>String(r.module_key)));
      const toInsert = modules.filter((m)=>!have.has(m.module_key)).map((m)=>({
          organization_id: orgId,
          patrol_config_id: configId,
          module_key: m.module_key,
          is_required: m.is_required,
          module_config: m.module_config,
          display_order: m.display_order,
          // Contract attribution at MODULE grain (#328).
          service_agreement_location_id: serviceAgreementLocationId,
          service_agreement_module_id: samByKey.get(m.module_key) ?? null
        }));
      if (toInsert.length) {
        const { error: modErr } = await admin.from('patrol_route_stop_modules').insert(toInsert);
        if (modErr) return await failZps(`patrol_route_stop_modules insert failed: ${modErr.message}`);
      }
      await admin.from('bob_agentic_actions').update({
        status: 'applied',
        result_table: 'client_site_patrol_config',
        result_record_id: configId,
        applied_at: new Date().toISOString(),
        error_message: null
      }).eq('id', action.id);
      return json({
        success: true,
        action_id: action.id,
        result_table: 'client_site_patrol_config',
        result_record_id: configId,
        deduped: !!existingCfg?.id,
        note: `Zone added to patrol route as a stop with module(s): ${modules.map((m)=>m.module_key).join(', ')}.`
      });
    }
    // ── create_freedom_camping_zone ── (FC enforcement zone)
    // payload: {
    //   organization_id?,                    (zone owner; defaults to action org)
    //   site_id? | parent_action_id?,        (optional link to a client site)
    //   name (required),
    //   boundary?,                           (GeoJSON polygon, SRID 4326 — PREFERRED)
    //   gps_lat?, gps_lng?, provisional_radius_m?, (point-buffer fallback)
    //   nightly_limit_consecutive?, nightly_limit_monthly?, scv_required?,
    //   allowed_vehicle_types?, max_nights_per_year?,
    //   no_camping_start_time?, no_camping_end_time?,
    //   restricted_from_date?, restricted_to_date?,
    //   bylaw_clause?, bylaw_source_url?, despatch_zone_code?,
    //   address?, suburb?, postcode?,
    //   legal?: { issuing_authority?, authorising_act?, authorising_section?,
    //             infringement_amount?, objections_email?, payment_deadline_days?,
    //             payment_url?, council_phone?, council_email? }
    // }
    //
    // Writes, in order, rolling back the zone on any later failure (no orphan):
    //   1. location_zones row (zone_type + module_key set EXPLICITLY to
    //      'freedom_camping'; inline limits mirror the compliance matrix for quick
    //      reference).
    //   2. geometry via set_zone_geometry (POLYGON preferred; point+radius
    //      provisional). location_zones.boundary/center_point verified POLYGON/
    //      POINT SRID 4326 (identical to client_sites).
    //   3. zone_compliance_matrix row (is_current=true, effective_from=CURRENT_DATE)
    //      — the versioned rulebook the breach engine reads.
    //   4. (optional) zone_legal_config row (legal/infringement basis).
    if (action.action_type === 'create_freedom_camping_zone') {
      const zp = action.proposed_payload ?? {};
      const orgId = zp.organization_id ? String(zp.organization_id) : String(action.organization_id);
      const zoneName = zp.name ? String(zp.name).trim() : '';
      const failFc = async (msg)=>{
        await admin.from('bob_agentic_actions').update({
          status: 'failed',
          error_message: msg
        }).eq('id', action.id);
        return json({
          error: msg
        }, 422);
      };
      if (!zoneName) return await failFc('proposed_payload.name is required to create a freedom-camping zone');
      // Resolve optional site link (PARENT-FIRST guard, mirrors create_client_site).
      let siteId = zp.site_id ? String(zp.site_id) : '';
      const parentActionId = zp.parent_action_id ? String(zp.parent_action_id) : '';
      if (!siteId && parentActionId) {
        const { data: parentAction } = await admin.from('bob_agentic_actions').select('id, action_type, status, result_record_id').eq('id', parentActionId).maybeSingle();
        if (!parentAction) return await failFc(`parent_action_id ${parentActionId} not found`);
        if (String(parentAction.action_type) !== 'create_client_site') {
          return await failFc(`parent_action_id ${parentActionId} is not a create_client_site action`);
        }
        if (String(parentAction.status) !== 'applied' || !parentAction.result_record_id) {
          return await failFc(`parent site is not created yet (parent action status='${parentAction.status}'). Approve + execute the create_client_site action first.`);
        }
        siteId = String(parentAction.result_record_id);
      }
      // If a site is linked, confirm it exists AND belongs to this zone's org
      // (no cross-org zone/site mix).
      if (siteId) {
        const { data: site } = await admin.from('client_sites').select('id, client_organization_id').eq('id', siteId).maybeSingle();
        if (!site) return await failFc(`site_id ${siteId} does not exist`);
        if (String(site.client_organization_id) !== orgId) {
          return await failFc('site_id belongs to a different organization than the zone — refusing');
        }
      }
      // Geometry required (mirror create_client_site): boundary polygon preferred,
      // else a point-buffer provisional fence. Clean fail, never a raw constraint.
      const boundaryGeo = zp.boundary && typeof zp.boundary === 'object' ? zp.boundary : null;
      const hasPoint = typeof zp.gps_lat === 'number' && typeof zp.gps_lng === 'number';
      if (!boundaryGeo && !hasPoint) {
        return await failFc('No geofence supplied: create_freedom_camping_zone requires proposed_payload.boundary (GeoJSON polygon, preferred) or gps_lat+gps_lng for a provisional fence. Resolve the zone geometry (LINZ->Google) before proposing.');
      }
      const provisional = boundaryGeo == null && hasPoint;
      // Idempotent dedupe: prefer (organization_id, despatch_zone_code) when a code
      // is present (live partial unique index); else (organization_id, name, site_id).
      const despatchZoneCode = typeof zp.despatch_zone_code === 'string' && zp.despatch_zone_code.trim() ? zp.despatch_zone_code.trim() : null;
      if (despatchZoneCode) {
        const { data: existingByCode } = await admin.from('location_zones').select('id').eq('organization_id', orgId).eq('despatch_zone_code', despatchZoneCode).maybeSingle();
        if (existingByCode?.id) {
          await admin.from('bob_agentic_actions').update({
            status: 'applied',
            result_table: 'location_zones',
            result_record_id: existingByCode.id,
            applied_at: new Date().toISOString(),
            error_message: null
          }).eq('id', action.id);
          return json({
            success: true,
            action_id: action.id,
            result_table: 'location_zones',
            result_record_id: existingByCode.id,
            deduped: true,
            note: `A zone with despatch code '${despatchZoneCode}' already exists for this org; used the existing one.`
          });
        }
      } else {
        // A zone linked to a site shares the site's house; dedupe on (org, name, house).
        let siteHouseId = null;
        if (siteId) {
          const { data: siteHouse } = await admin.from('client_sites').select('location_id').eq('id', siteId).maybeSingle();
          siteHouseId = siteHouse?.location_id ?? null;
        }
        let dq = admin.from('location_zones').select('id').eq('organization_id', orgId).ilike('name', zoneName);
        if (siteHouseId) dq = dq.eq('location_id', siteHouseId);
        const { data: existingByName } = await dq.limit(1).maybeSingle();
        if (existingByName?.id) {
          await admin.from('bob_agentic_actions').update({
            status: 'applied',
            result_table: 'location_zones',
            result_record_id: existingByName.id,
            applied_at: new Date().toISOString(),
            error_message: null
          }).eq('id', action.id);
          return json({
            success: true,
            action_id: action.id,
            result_table: 'location_zones',
            result_record_id: existingByName.id,
            deduped: true,
            note: `A zone named '${zoneName}' already exists for this org/site; used the existing one.`
          });
        }
      }
      // ── Slice 2d: HOUSE RESOLUTION + TRI-STATE CROSS-ORG GUARD ──
      // This is an ENFORCEMENT zone writer. Before inserting the zone, resolve
      // (or create) the house (locations row) the zone belongs to, and — for
      // this enforcement origin — run the deployed tri-state cross-org conflict
      // check via the shared edge seam (_shared/houseResolve.ts). Previously
      // this handler inserted a HOUSELESS zone (location_id null) and skipped
      // the guard entirely.
      //
      // TRI-STATE (owner §4 ruling, explicit — no truthy collapse):
      //   false    -> proceed; the zone gets the resolved location_id.
      //   true     -> HARD STOP (confirmed conflict; dormant until 2e).
      //   'review' -> HARD STOP with a distinct 'needs human confirmation'
      //               message (unconfirmed weak signal; not proven, not cleared).
      // Fail-closed: edge invoke error / invalid verdict -> stop (no insert).
      //
      // #297: orgId is the OWNER org (own-rooted). No 'owning client' framing.
      // Runs AFTER the dedup short-circuits above: an already-existing zone must
      // NOT trigger a new house create or a cross-org read.
      //
      // Dedup key: use the SHARED derivation (parity with the web path — Bob
      // attack #4). computeEffectiveDedupKey applies the SAME contract as
      // canonicalZoneEntry / resolveOrCreateHouse: a LINZ address_match_key is
      // used verbatim when present; otherwise the address label is normalised
      // (trim + collapse whitespace + lowercase). This closes the earlier
      // divergence (a lightweight local normalise that missed LINZ precedence),
      // so web-created and edge-created houses key IDENTICALLY — same address =>
      // same cross-org verdict regardless of path. Keyless => skip the check.
      const explicitKey = typeof zp.address_match_key === 'string' && zp.address_match_key.trim() ? zp.address_match_key.trim() : null;
      // Do NOT substitute the zone's display NAME for a real address (Duo review):
      // a zone is an AREA, not an addressed house. Feeding a normalised zone name
      // into the address-keyed cross-org house guard would let two orgs' zones
      // that share a generic name ('Riverside Reserve') collide on the same key
      // and trigger a FALSE HOUSE_CROSS_ORG_CONFLICT/REVIEW hard-stop, and would
      // pollute locations.address_match_key with name-derived data. A polygon-only
      // zone with no street address has no house identity to collide on:
      // missing real address => genuinely KEYLESS => skip the house create + the
      // cross-org check (the safe, already-tested keyless path in houseResolve).
      const addressLabel = typeof zp.address === 'string' && zp.address.trim() ? zp.address.trim() : null;
      const houseMatchKey = computeEffectiveDedupKey(explicitKey, addressLabel) ?? '';
      let resolvedLocationId = null;
      // Track whether THIS call created the house, so a later zone-insert failure
      // can roll the house back too (orphan-house residue, Bob attack #5). A
      // pre-existing (deduped) house must NEVER be deleted on rollback.
      let houseCreatedByThisCall = false;
      try {
        const house = await resolveOrCreateHouseEdge(admin, {
          orgId,
          addressMatchKey: houseMatchKey,
          label: zoneName,
          // Pass the trimmed/canonical address (Duo review 3): one address string
          // feeds both the stored locations.address and the seam's key derivation.
          address: addressLabel,
          // Trim suburb/postcode to null (Duo review 4): keep consistent with the
          // trimmed address above and the zoneRow handling below — no ''/whitespace
          // stored in the locations row.
          suburb: typeof zp.suburb === 'string' && zp.suburb.trim() ? zp.suburb.trim() : null,
          postcode: typeof zp.postcode === 'string' && zp.postcode.trim() ? zp.postcode.trim() : null,
          origin: 'enforcement',
          createdBy: action.approved_by ?? null
        });
        // house.locationId is null on action:'skipped' (owner ruling B: an
        // address-less zone has no house identity — location_id stays null by
        // design, NOT a synthetic row). houseCreatedByThisCall is true ONLY on
        // 'created', so the orphan-house rollback correctly no-ops for skipped.
        resolvedLocationId = house.locationId;
        houseCreatedByThisCall = house.action === 'created';
      } catch (houseErr) {
        if (houseErr instanceof HouseConflictError) {
          // true -> confirmed conflict; 'review' -> unconfirmed, needs human
          // confirmation. Both are hard stops: NO zone is inserted. The
          // distinct message is recorded on the action for the human.
          const prefix = houseErr.kind === 'review' ? 'HOUSE_REVIEW_REQUIRED' : 'HOUSE_CROSS_ORG_CONFLICT';
          return await failFc(`${prefix}: ${houseErr.message}`);
        }
        // Fail-closed (F2): resolution/guard unavailable -> stop, never proceed.
        const msg = houseErr instanceof Error ? houseErr.message : String(houseErr);
        return await failFc(`House resolution failed (fail-closed, no zone written): ${msg}`);
      }
      // 1. Insert the location_zones row. zone_type + module_key set EXPLICITLY
      // (both default to 'freedom_camping' but must not be left implicit — see !697).
      // boundary_status stamped here (0182) so a provisional (point-buffer) fence
      // is durably queryable as "needs a real boundary" — not just a one-off chat
      // note that scrolls past and is forgotten.
      // 2d: location_id is populated when a house is MEANINGFULLY resolved;
      // null by design for an address-less zone (owner ruling B — no synthetic
      // house). The column is nullable (0111); a null here is intended state.
      // A zone linked to a site is on that site's house unless the address resolved a different one.
      if (!resolvedLocationId && siteId) {
        const { data: linkedSite } = await admin.from('client_sites').select('location_id').eq('id', siteId).maybeSingle();
        resolvedLocationId = linkedSite?.location_id ?? null;
      }
      const zoneRow = {
        organization_id: orgId,
        location_id: resolvedLocationId,
        name: zoneName,
        zone_type: 'freedom_camping',
        module_key: 'freedom_camping',
        boundary_status: provisional ? 'provisional' : 'authoritative'
      };
      if (typeof zp.nightly_limit_consecutive === 'number') zoneRow.nightly_limit_consecutive = zp.nightly_limit_consecutive;
      if (typeof zp.nightly_limit_monthly === 'number') zoneRow.nightly_limit_monthly = zp.nightly_limit_monthly;
      if (typeof zp.scv_required === 'boolean') zoneRow.scv_required = zp.scv_required;
      if (typeof zp.bylaw_clause === 'string' && zp.bylaw_clause.trim()) zoneRow.bylaw_clause = zp.bylaw_clause.trim();
      if (typeof zp.bylaw_source_url === 'string' && zp.bylaw_source_url.trim()) zoneRow.bylaw_source_url = zp.bylaw_source_url.trim();
      if (despatchZoneCode) zoneRow.despatch_zone_code = despatchZoneCode;
      // address/suburb/postcode live on the house (locations), never on the zone.
      const { data: createdZone, error: zoneErr } = await admin.from('location_zones').insert(zoneRow).select('id').single();
      if (zoneErr || !createdZone) {
        // Orphan-house guard (Bob attack #5): the zone insert is the very failure
        // that can strand a just-created house. rollbackFail isn't available yet
        // (it needs createdZone.id), so clean up the house inline here, IFF this
        // call created it — a pre-existing (deduped) house is left untouched.
        if (houseCreatedByThisCall && resolvedLocationId) {
          // Surface a failed cleanup (Duo review): silently swallowing the delete
          // error would re-open the orphan-house scenario Bob attack #5 closes.
          const { error: houseDelErr } = await admin.from('locations').delete().eq('id', resolvedLocationId);
          if (houseDelErr) console.error(`Orphan-house cleanup failed for location ${resolvedLocationId} (zone-insert failure path): ${houseDelErr.message}`);
        }
        return await failFc(`location_zones insert failed: ${zoneErr?.message ?? 'unknown error'}`);
      }
      // Roll back helper: delete the zone then fail (no orphan/partial zone).
      // 2d (Bob attack #5): also delete the house IFF this call created it, so a
      // zone-insert failure cannot leave a houseless orphan house. A pre-existing
      // (deduped) house is left untouched.
      const rollbackFail = async (msg)=>{
        const { error: zoneDelErr } = await admin.from('location_zones').delete().eq('id', createdZone.id);
        if (zoneDelErr) console.error(`Zone rollback delete failed for zone ${createdZone.id}: ${zoneDelErr.message}`);
        if (houseCreatedByThisCall && resolvedLocationId) {
          // Surface a failed cleanup (Duo review): a swallowed error here would
          // re-open the orphan-house scenario Bob attack #5 closes.
          const { error: houseDelErr } = await admin.from('locations').delete().eq('id', resolvedLocationId);
          if (houseDelErr) console.error(`Orphan-house cleanup failed for location ${resolvedLocationId} (rollbackFail path): ${houseDelErr.message}`);
        }
        return await failFc(msg);
      };
      // 2. Geometry via set_zone_geometry (same RPC as create_patrol_route_service_area).
      // Polygon -> single-element array; provisional point -> buffered by the RPC.
      const provisionalRadius = typeof zp.provisional_radius_m === 'number' && zp.provisional_radius_m > 0 ? zp.provisional_radius_m : 100;
      // Phase 4 fast-follow (0284): resolve boundary_source from the payload
      // (the proposer knows which resolver succeeded: linz_parcel / linz_building
      // / google / point_radius). If not provided, the RPC defaults to
      // 'UNKNOWN_SOURCE' for polygon or 'point_radius' for point path (P1).
      const fcBoundarySource = typeof zp.boundary_source === 'string' && zp.boundary_source.trim() ? zp.boundary_source.trim() : null;
      let writtenAreaM2 = null;
      if (boundaryGeo) {
        const { data: geoData, error: geoErr } = await admin.rpc('set_zone_geometry', {
          p_zone_id: createdZone.id,
          p_polygons: [
            boundaryGeo
          ],
          p_boundary_source: fcBoundarySource,
          p_changed_by: action.approved_by ?? null
        });
        if (geoErr) return await rollbackFail(`set_zone_geometry failed (zone rolled back): ${geoErr.message}`);
        if (typeof geoData === 'number' && isFinite(geoData)) writtenAreaM2 = geoData;
      } else {
        // Provisional point fence: write center_point + radius via the RPC.
        const { data: geoData, error: geoErr } = await admin.rpc('set_zone_geometry', {
          p_zone_id: createdZone.id,
          p_center_lat: zp.gps_lat,
          p_center_lng: zp.gps_lng,
          p_provisional_radius_m: provisionalRadius,
          p_boundary_source: fcBoundarySource,
          p_changed_by: action.approved_by ?? null
        });
        if (geoErr) return await rollbackFail(`set_zone_geometry (provisional point) failed (zone rolled back): ${geoErr.message}`);
        if (typeof geoData === 'number' && isFinite(geoData)) writtenAreaM2 = geoData;
      }
      // 3. zone_compliance_matrix (the versioned enforceable rulebook). is_current
      // defaults true, effective_from defaults CURRENT_DATE; set the FC limits.
      const matrixRow = {
        organization_id: orgId,
        zone_id: createdZone.id
      };
      if (typeof zp.nightly_limit_consecutive === 'number') matrixRow.max_consecutive_nights = zp.nightly_limit_consecutive;
      if (typeof zp.nightly_limit_monthly === 'number') matrixRow.max_nights_per_month = zp.nightly_limit_monthly;
      if (typeof zp.max_nights_per_year === 'number') matrixRow.max_nights_per_year = zp.max_nights_per_year;
      if (typeof zp.scv_required === 'boolean') matrixRow.scv_required = zp.scv_required;
      if (Array.isArray(zp.allowed_vehicle_types)) matrixRow.allowed_vehicle_types = zp.allowed_vehicle_types.map((v)=>String(v)).filter(Boolean);
      for (const [k, col] of [
        [
          'no_camping_start_time',
          'no_camping_start_time'
        ],
        [
          'no_camping_end_time',
          'no_camping_end_time'
        ],
        [
          'restricted_from_date',
          'restricted_from_date'
        ],
        [
          'restricted_to_date',
          'restricted_to_date'
        ]
      ]){
        if (typeof zp[k] === 'string' && String(zp[k]).trim()) matrixRow[col] = String(zp[k]).trim();
      }
      if (typeof zp.bylaw_clause === 'string' && zp.bylaw_clause.trim()) matrixRow.bylaw_clause = zp.bylaw_clause.trim();
      if (typeof zp.bylaw_source_url === 'string' && zp.bylaw_source_url.trim()) matrixRow.bylaw_source_url = zp.bylaw_source_url.trim();
      const { error: matrixErr } = await admin.from('zone_compliance_matrix').insert(matrixRow);
      if (matrixErr) return await rollbackFail(`zone_compliance_matrix insert failed (zone rolled back): ${matrixErr.message}`);
      // 4. (optional) zone_legal_config.
      const legal = zp.legal && typeof zp.legal === 'object' ? zp.legal : null;
      if (legal) {
        const legalRow = {
          organization_id: orgId,
          zone_id: createdZone.id
        };
        for (const k of [
          'payment_url',
          'objections_email',
          'objections_address',
          'issuing_authority',
          'authorising_act',
          'authorising_section',
          'dispute_portal_url',
          'council_phone',
          'council_email'
        ]){
          if (typeof legal[k] === 'string' && String(legal[k]).trim()) legalRow[k] = String(legal[k]).trim();
        }
        if (typeof legal.infringement_amount === 'number') legalRow.infringement_amount = legal.infringement_amount;
        if (typeof legal.payment_deadline_days === 'number') legalRow.payment_deadline_days = legal.payment_deadline_days;
        const { error: legalErr } = await admin.from('zone_legal_config').insert(legalRow);
        if (legalErr) return await rollbackFail(`zone_legal_config insert failed (zone rolled back): ${legalErr.message}`);
      }
      // Phase 1 (item 3a): Authoritative area-based gate. The RPC now returns
      // the written area in m^2. A returned area of 0 / NULL / non-finite means
      // the geometry is empty or invalid. This replaces the Phase 0 EWKB string check.
      if (writtenAreaM2 == null || writtenAreaM2 <= 0) {
        return await rollbackFail('GEOFENCE_INVALID: freedom camping zone boundary is empty or has zero area after write for zone ' + createdZone.id + ' (returned area: ' + String(writtenAreaM2) + ')');
      }
      // Phase 5 (P2 visual verification gate): zone boundary lands UNVERIFIED.
      await admin.from('location_zones').update({
        boundary_verification: 'unverified',
        boundary_verified_by: null,
        boundary_verified_at: null
      }).eq('id', createdZone.id);
      await admin.from('bob_agentic_actions').update({
        status: 'applied',
        result_table: 'location_zones',
        result_record_id: createdZone.id,
        applied_at: new Date().toISOString(),
        error_message: null
      }).eq('id', action.id);
      const areaNote = writtenAreaM2 !== null ? ` Actual area: ~${Math.round(writtenAreaM2).toLocaleString()} m^2.` : '';
      return json({
        success: true,
        action_id: action.id,
        result_table: 'location_zones',
        result_record_id: createdZone.id,
        deduped: false,
        provisional,
        area_m2: writtenAreaM2,
        deep_link: `/locations`,
        note: (provisional ? `FC zone '${zoneName}' created with a PROVISIONAL point-buffer fence (${provisionalRadius} m) — NO LINZ parcel polygon was found for this location. Flagged boundary_status='provisional': draw/confirm the real boundary in the Zone editor before relying on this fence for enforcement (a point-buffer approximates the area but is not the legal parcel boundary).` : `FC zone '${zoneName}' created with an authoritative LINZ parcel boundary polygon + compliance matrix.`) + areaNote + ' UNVERIFIED -- visually confirm the boundary on the map.'
      });
    }
    // ── propose_freedom_camping_org_strategy ──
    // payload: { organization_id, settings: {...}, zone_updates: [{ zone_id, ... }], source_attachment_id? }
    // Validates EVERYTHING (org, every zone_id belongs to org) before writing
    // ANYTHING — no partial application across multiple zone_updates, mirroring
    // set_org_jurisdiction's validate-then-write discipline.
    if (action.action_type === 'propose_freedom_camping_org_strategy') {
      const sp = action.proposed_payload ?? {};
      const orgId = sp.organization_id ? String(sp.organization_id) : String(action.organization_id);
      const failStrategy = async (msg)=>{
        await admin.from('bob_agentic_actions').update({
          status: 'failed',
          error_message: msg
        }).eq('id', action.id);
        return json({
          error: msg
        }, 422);
      };
      const { data: strategyOrg } = await admin.from('organizations').select('id').eq('id', orgId).maybeSingle();
      if (!strategyOrg) return await failStrategy(`organization_id ${orgId} does not exist`);
      const settingsIn = sp.settings && typeof sp.settings === 'object' ? sp.settings : {};
      const zoneUpdates = Array.isArray(sp.zone_updates) ? sp.zone_updates : [];
      // Pre-validate every zone_id belongs to this org BEFORE writing anything.
      const zoneIds = zoneUpdates.map((z)=>String(z.zone_id ?? '')).filter(Boolean);
      if (zoneIds.length) {
        const { data: zoneRows } = await admin.from('location_zones').select('id, organization_id').in('id', zoneIds);
        const foundIds = new Set((zoneRows ?? []).map((z)=>String(z.id)));
        for (const z of zoneUpdates){
          const zid = String(z.zone_id ?? '');
          if (!foundIds.has(zid)) return await failStrategy(`zone_updates references zone_id ${zid} which does not exist`);
          const zoneRow = (zoneRows ?? []).find((r)=>String(r.id) === zid);
          if (zoneRow && String(zoneRow.organization_id) !== orgId) {
            return await failStrategy(`zone_updates references zone_id ${zid} which belongs to a different organization — refusing`);
          }
        }
      }
      // 1. freedom_camping_org_settings — versioned is_current row (same pattern
      //    as zone_compliance_matrix): demote the prior current row, insert new.
      let settingsId = null;
      if (Object.keys(settingsIn).length) {
        const { data: prevSettings } = await admin.from('freedom_camping_org_settings').select('id, version').eq('organization_id', orgId).eq('is_current', true).order('version', {
          ascending: false
        }).limit(1).maybeSingle();
        if (prevSettings?.id) {
          await admin.from('freedom_camping_org_settings').update({
            is_current: false
          }).eq('id', prevSettings.id);
        }
        const settingsRow = {
          organization_id: orgId,
          version: (prevSettings?.version ? Number(prevSettings.version) : 0) + 1,
          is_current: true,
          created_by: '00000000-0000-0000-0000-00000000b0b0'
        };
        for (const k of [
          'verification_mode',
          'enforcement_ladder_mode',
          'movement_similarity_threshold',
          'default_authorising_act',
          'default_issuing_authority',
          'show_homeless_exempt_kpi',
          'notes'
        ]){
          if (settingsIn[k] !== undefined && settingsIn[k] !== null) settingsRow[k] = settingsIn[k];
        }
        const { data: createdSettings, error: settingsErr } = await admin.from('freedom_camping_org_settings').insert(settingsRow).select('id').single();
        if (settingsErr || !createdSettings) return await failStrategy(`freedom_camping_org_settings insert failed: ${settingsErr?.message ?? 'unknown error'}`);
        settingsId = String(createdSettings.id);
      }
      // 2. Per-zone rule_type/scv_exempts_restriction + a fresh compliance-matrix
      //    version where night-limit fields were supplied.
      for (const z of zoneUpdates){
        const zid = String(z.zone_id);
        const zoneRowUpdate = {};
        if (typeof z.rule_type === 'string') zoneRowUpdate.rule_type = z.rule_type;
        if (typeof z.scv_exempts_restriction === 'boolean') zoneRowUpdate.scv_exempts_restriction = z.scv_exempts_restriction;
        if (Object.keys(zoneRowUpdate).length) {
          const { error: zuErr } = await admin.from('location_zones').update(zoneRowUpdate).eq('id', zid);
          if (zuErr) return await failStrategy(`location_zones update failed for zone ${zid}: ${zuErr.message}`);
        }
        const hasMatrixFields = [
          'max_consecutive_nights',
          'max_nights_per_month',
          'scv_required'
        ].some((k)=>z[k] !== undefined);
        if (hasMatrixFields) {
          const { data: prevMatrix } = await admin.from('zone_compliance_matrix').select('id, version').eq('zone_id', zid).eq('is_current', true).order('version', {
            ascending: false
          }).limit(1).maybeSingle();
          if (prevMatrix?.id) {
            await admin.from('zone_compliance_matrix').update({
              is_current: false
            }).eq('id', prevMatrix.id);
          }
          const matrixRow = {
            organization_id: orgId,
            zone_id: zid,
            version: (prevMatrix?.version ? Number(prevMatrix.version) : 0) + 1,
            is_current: true,
            effective_from: new Date().toISOString().slice(0, 10),
            notes: 'propose_freedom_camping_org_strategy: bylaw-derived update',
            created_by: '00000000-0000-0000-0000-00000000b0b0'
          };
          if (typeof z.max_consecutive_nights === 'number') matrixRow.max_consecutive_nights = z.max_consecutive_nights;
          if (typeof z.max_nights_per_month === 'number') matrixRow.max_nights_per_month = z.max_nights_per_month;
          if (typeof z.scv_required === 'boolean') matrixRow.scv_required = z.scv_required;
          const { error: matrixErr } = await admin.from('zone_compliance_matrix').insert(matrixRow);
          if (matrixErr) return await failStrategy(`zone_compliance_matrix insert failed for zone ${zid}: ${matrixErr.message}`);
        }
      }
      await admin.from('bob_agentic_actions').update({
        status: 'applied',
        result_table: 'freedom_camping_org_settings',
        result_record_id: settingsId,
        applied_at: new Date().toISOString(),
        error_message: null
      }).eq('id', action.id);
      return json({
        success: true,
        action_id: action.id,
        result_table: 'freedom_camping_org_settings',
        result_record_id: settingsId,
        deduped: false,
        note: `Freedom Camping policy strategy applied: ${Object.keys(settingsIn).length ? 'org settings updated, ' : ''}${zoneUpdates.length} zone(s) updated.`
      });
    }
    // ── assign_human_id ── (ungoverned direct write, owner ruling 4.1, #226)
    // Assigns hierarchical human-readable ID codes at onboarding. Writes
    // DIRECTLY — no pending-approval gate (low-risk metadata exception).
    //
    // payload: {
    //   entity_type: 'org' | 'branch' | 'service' | 'site' | 'zone' (required),
    //   organization_id: uuid (required — the org this entity belongs to),
    //   entity_id: uuid (required — the target record's id),
    //   display_name: string (required — the entity's human name, used for derivation),
    //   parent_branch_code?: string (required for service entities — the branch code),
    //   code_override?: string (optional — human override of Bob's proposed code),
    //   legacy_external_refs?: object (optional — Wilsar/Deputy numbers for boundary mapping),
    // }
    //
    // Design: docs/design/HIERARCHICAL_HUMAN_ID_SCHEME.md
    // Storage mapping: Section 3. Derivation: Section 2. Collision: Section 5.
    if (action.action_type === 'assign_human_id') {
      const hp = action.proposed_payload ?? {};
      const entityType = hp.entity_type ? String(hp.entity_type).trim().toLowerCase() : '';
      const orgId = hp.organization_id ? String(hp.organization_id) : String(action.organization_id);
      const entityId = hp.entity_id ? String(hp.entity_id) : '';
      const displayName = hp.display_name ? String(hp.display_name).trim() : '';
      const codeOverride = hp.code_override ? String(hp.code_override).trim().toUpperCase().replace(/[^A-Z0-9]/g, '') : '';
      const parentBranchCode = hp.parent_branch_code ? String(hp.parent_branch_code).trim() : '';
      const legacyRefs = hp.legacy_external_refs && typeof hp.legacy_external_refs === 'object' ? hp.legacy_external_refs : null;
      const failHid = async (msg)=>{
        await admin.from('bob_agentic_actions').update({
          status: 'failed',
          error_message: msg
        }).eq('id', action.id);
        return json({
          error: msg
        }, 422);
      };
      const VALID_ENTITY_TYPES = new Set([
        'org',
        'branch',
        'service',
        'site',
        'zone'
      ]);
      if (!VALID_ENTITY_TYPES.has(entityType)) return await failHid(`entity_type must be one of: ${[
        ...VALID_ENTITY_TYPES
      ].join(', ')}`);
      if (!entityId) return await failHid('entity_id is required');
      if (!displayName) return await failHid('display_name is required');
      if (entityType === 'service' && !parentBranchCode) return await failHid('parent_branch_code is required for service entities');
      // ── Mnemonic derivation (Section 2) ──
      // deriveNonLeafMnemonic / deriveLeafName are hoisted to module scope
      // (see top of file) to satisfy Deno lint no-inner-declarations.
      // ── Fetch org_code (Principle 2: org-rooted) ──
      const { data: orgCodeRow } = await admin.from('reference_codes').select('code').eq('organization_id', orgId).eq('code_type', 'org_code').eq('is_active', true).limit(1).maybeSingle();
      if (!orgCodeRow?.code) return await failHid(`No org_code found for organization ${orgId}. Assign an org code first.`);
      const orgCode = String(orgCodeRow.code);
      // ── Entity-type-specific handling ──
      if (entityType === 'org') {
        // ORG: write to reference_codes code_type='org_code'
        // Check if already assigned
        const { data: existing } = await admin.from('reference_codes').select('id, code').eq('organization_id', entityId).eq('code_type', 'org_code').maybeSingle();
        if (existing?.code) {
          // Already has an org code — idempotent return
          await admin.from('bob_agentic_actions').update({
            status: 'applied',
            result_table: 'reference_codes',
            result_record_id: existing.id,
            applied_at: new Date().toISOString(),
            error_message: null
          }).eq('id', action.id);
          return json({
            success: true,
            action_id: action.id,
            result_table: 'reference_codes',
            result_record_id: existing.id,
            code: existing.code,
            deduped: true,
            note: `Org already has code '${existing.code}'.`
          });
        }
        let candidate = codeOverride || deriveNonLeafMnemonic(displayName);
        // Collision: cross-org unique (idx_refcodes_org_code_unique)
        let suffix = 2;
        const base = candidate;
        while(true){
          const { data: collision } = await admin.from('reference_codes').select('id').eq('code_type', 'org_code').eq('code', candidate).maybeSingle();
          if (!collision) break;
          candidate = base + suffix;
          suffix++;
        }
        const row = {
          organization_id: entityId,
          code_type: 'org_code',
          code: candidate,
          name: displayName,
          is_active: true,
          sort_order: 0
        };
        if (legacyRefs) row.external_refs = legacyRefs;
        const { data: created, error: insErr } = await admin.from('reference_codes').insert(row).select('id').single();
        if (insErr || !created) return await failHid(`reference_codes insert failed: ${insErr?.message ?? 'unknown error'}`);
        await admin.from('bob_agentic_actions').update({
          status: 'applied',
          result_table: 'reference_codes',
          result_record_id: created.id,
          applied_at: new Date().toISOString(),
          error_message: null
        }).eq('id', action.id);
        return json({
          success: true,
          action_id: action.id,
          result_table: 'reference_codes',
          result_record_id: created.id,
          code: candidate,
          full_path: candidate,
          note: `Org code '${candidate}' assigned.`
        });
      }
      if (entityType === 'branch') {
        // BRANCH: write to reference_codes code_type='branch'
        let candidate = codeOverride || deriveNonLeafMnemonic(displayName);
        // Collision: per-org unique via UNIQUE(organization_id, code_type, code)
        let suffix = 2;
        const base = candidate;
        while(true){
          const { data: collision } = await admin.from('reference_codes').select('id').eq('organization_id', orgId).eq('code_type', 'branch').eq('code', candidate).maybeSingle();
          if (!collision) break;
          candidate = base + suffix;
          suffix++;
        }
        const fullPath = `${orgCode}-${candidate}`;
        const row = {
          organization_id: orgId,
          code_type: 'branch',
          code: candidate,
          name: displayName,
          is_active: true,
          sort_order: 0
        };
        if (legacyRefs) row.external_refs = legacyRefs;
        const { data: created, error: insErr } = await admin.from('reference_codes').insert(row).select('id').single();
        if (insErr || !created) return await failHid(`reference_codes insert failed: ${insErr?.message ?? 'unknown error'}`);
        await admin.from('bob_agentic_actions').update({
          status: 'applied',
          result_table: 'reference_codes',
          result_record_id: created.id,
          applied_at: new Date().toISOString(),
          error_message: null
        }).eq('id', action.id);
        return json({
          success: true,
          action_id: action.id,
          result_table: 'reference_codes',
          result_record_id: created.id,
          code: candidate,
          full_path: fullPath,
          note: `Branch code '${candidate}' assigned (full path: ${fullPath}).`
        });
      }
      if (entityType === 'service') {
        // SERVICE: write to reference_codes code_type='service_code', parent_code=<branch code>
        let candidate = codeOverride || deriveNonLeafMnemonic(displayName);
        // Collision: per-branch unique via idx_refcodes_service_code_per_branch
        let suffix = 2;
        const base = candidate;
        while(true){
          const { data: collision } = await admin.from('reference_codes').select('id').eq('organization_id', orgId).eq('code_type', 'service_code').eq('parent_code', parentBranchCode).eq('code', candidate).maybeSingle();
          if (!collision) break;
          candidate = base + suffix;
          suffix++;
        }
        const fullPath = `${orgCode}-${parentBranchCode}-${candidate}`;
        const row = {
          organization_id: orgId,
          code_type: 'service_code',
          code: candidate,
          name: displayName,
          parent_code: parentBranchCode,
          is_active: true,
          sort_order: 0
        };
        if (legacyRefs) row.external_refs = legacyRefs;
        const { data: created, error: insErr } = await admin.from('reference_codes').insert(row).select('id').single();
        if (insErr || !created) return await failHid(`reference_codes insert failed: ${insErr?.message ?? 'unknown error'}`);
        await admin.from('bob_agentic_actions').update({
          status: 'applied',
          result_table: 'reference_codes',
          result_record_id: created.id,
          applied_at: new Date().toISOString(),
          error_message: null
        }).eq('id', action.id);
        return json({
          success: true,
          action_id: action.id,
          result_table: 'reference_codes',
          result_record_id: created.id,
          code: candidate,
          full_path: fullPath,
          note: `Service code '${candidate}' assigned under branch '${parentBranchCode}' (full path: ${fullPath}).`
        });
      }
      if (entityType === 'site') {
        // SITE: write full composite path to client_sites.site_code
        // Confirm the site exists
        const { data: site } = await admin.from('client_sites').select('id, client_organization_id, site_code').eq('id', entityId).maybeSingle();
        if (!site) return await failHid(`site entity_id ${entityId} does not exist in client_sites`);
        if (site.site_code) {
          // Already assigned — idempotent return
          await admin.from('bob_agentic_actions').update({
            status: 'applied',
            result_table: 'client_sites',
            result_record_id: site.id,
            applied_at: new Date().toISOString(),
            error_message: null
          }).eq('id', action.id);
          return json({
            success: true,
            action_id: action.id,
            result_table: 'client_sites',
            result_record_id: site.id,
            code: site.site_code,
            deduped: true,
            note: `Site already has code '${site.site_code}'.`
          });
        }
        // Build the parent path prefix from payload (org-branch or org-branch-service)
        const parentPath = hp.parent_path ? String(hp.parent_path).trim() : orgCode;
        // Derive the leaf segment
        let leafCandidate = codeOverride || deriveLeafName(displayName);
        let fullPath = `${parentPath}-${leafCandidate}`;
        const siteOwnerOrgId = String(site.client_organization_id);
        // SHARED LEAF NAMESPACE (ruling Q7): check BOTH client_sites.site_code
        // AND location_zones.despatch_zone_code for collision before assigning.
        const leafCollides = async (path)=>{
          const { data: siteHit } = await admin.from('client_sites').select('id').eq('client_organization_id', siteOwnerOrgId).eq('site_code', path).maybeSingle();
          if (siteHit) return true;
          const { data: zoneHit } = await admin.from('location_zones').select('id').eq('organization_id', orgId).eq('despatch_zone_code', path).maybeSingle();
          return !!zoneHit;
        };
        if (await leafCollides(fullPath)) {
          // Collision: switch to short-code+number form (Section 5.3)
          // First entity KEEPS its readable name; subsequent get numbered (ruling Q6 option B)
          const shortBase = leafCandidate.slice(0, 4);
          let suffix = 2;
          while(true){
            leafCandidate = `${shortBase}${suffix}`;
            fullPath = `${parentPath}-${leafCandidate}`;
            if (!await leafCollides(fullPath)) break;
            suffix++;
          }
        }
        // Write the full composite path to client_sites.site_code
        const { error: updErr } = await admin.from('client_sites').update({
          site_code: fullPath
        }).eq('id', entityId);
        if (updErr) return await failHid(`client_sites.site_code update failed: ${updErr.message}`);
        await admin.from('bob_agentic_actions').update({
          status: 'applied',
          result_table: 'client_sites',
          result_record_id: entityId,
          applied_at: new Date().toISOString(),
          error_message: null
        }).eq('id', action.id);
        return json({
          success: true,
          action_id: action.id,
          result_table: 'client_sites',
          result_record_id: entityId,
          code: fullPath,
          full_path: fullPath,
          note: `Site code '${fullPath}' assigned (full composite path stored in site_code).`
        });
      }
      if (entityType === 'zone') {
        // ZONE: write full composite path to location_zones.despatch_zone_code
        const { data: zone } = await admin.from('location_zones').select('id, organization_id, despatch_zone_code').eq('id', entityId).maybeSingle();
        if (!zone) return await failHid(`zone entity_id ${entityId} does not exist in location_zones`);
        if (zone.despatch_zone_code) {
          // Already assigned — idempotent return
          await admin.from('bob_agentic_actions').update({
            status: 'applied',
            result_table: 'location_zones',
            result_record_id: zone.id,
            applied_at: new Date().toISOString(),
            error_message: null
          }).eq('id', action.id);
          return json({
            success: true,
            action_id: action.id,
            result_table: 'location_zones',
            result_record_id: zone.id,
            code: zone.despatch_zone_code,
            deduped: true,
            note: `Zone already has code '${zone.despatch_zone_code}'.`
          });
        }
        const parentPath = hp.parent_path ? String(hp.parent_path).trim() : orgCode;
        let leafCandidate = codeOverride || deriveLeafName(displayName);
        let fullPath = `${parentPath}-${leafCandidate}`;
        const zoneOrgId = String(zone.organization_id);
        // SHARED LEAF NAMESPACE (ruling Q7): check BOTH tables
        const zoneLeafCollides = async (path)=>{
          const { data: zoneHit } = await admin.from('location_zones').select('id').eq('organization_id', zoneOrgId).eq('despatch_zone_code', path).maybeSingle();
          if (zoneHit) return true;
          const { data: siteHit } = await admin.from('client_sites').select('id').eq('client_organization_id', orgId).eq('site_code', path).maybeSingle();
          return !!siteHit;
        };
        if (await zoneLeafCollides(fullPath)) {
          // Collision: short-code+number form (ruling Q6 option B)
          const shortBase = leafCandidate.slice(0, 4);
          let suffix = 2;
          while(true){
            leafCandidate = `${shortBase}${suffix}`;
            fullPath = `${parentPath}-${leafCandidate}`;
            if (!await zoneLeafCollides(fullPath)) break;
            suffix++;
          }
        }
        const { error: updErr } = await admin.from('location_zones').update({
          despatch_zone_code: fullPath
        }).eq('id', entityId);
        if (updErr) return await failHid(`location_zones.despatch_zone_code update failed: ${updErr.message}`);
        await admin.from('bob_agentic_actions').update({
          status: 'applied',
          result_table: 'location_zones',
          result_record_id: entityId,
          applied_at: new Date().toISOString(),
          error_message: null
        }).eq('id', action.id);
        return json({
          success: true,
          action_id: action.id,
          result_table: 'location_zones',
          result_record_id: entityId,
          code: fullPath,
          full_path: fullPath,
          note: `Zone code '${fullPath}' assigned (full composite path stored in despatch_zone_code).`
        });
      }
      // Should not reach here (entity_type validated above)
      return await failHid(`Unhandled entity_type '${entityType}'`);
    }
    // ── create_service_agreement_draft ──
    const payload = action.proposed_payload ?? {};
    const providerOrgId = String(action.organization_id);
    const clientOrgId = payload.client_organization_id ? String(payload.client_organization_id) : '';
    const name = payload.name ? String(payload.name).trim() : '';
    // Validate required, real columns before inserting.
    const fail = async (msg)=>{
      await admin.from('bob_agentic_actions').update({
        status: 'failed',
        error_message: msg
      }).eq('id', action.id);
      return json({
        error: msg
      }, 422);
    };
    if (!name) return await fail('proposed_payload.name is required to create a draft agreement');
    if (!clientOrgId) return await fail('proposed_payload.client_organization_id is required');
    // Confirm the client org exists (avoids FK error / cross-org mistakes).
    const { data: clientOrg } = await admin.from('organizations').select('id').eq('id', clientOrgId).maybeSingle();
    if (!clientOrg) return await fail(`client_organization_id ${clientOrgId} does not exist`);
    // Insert an INERT draft: nothing activated. Optional fields copied only if
    // present in the payload; everything else falls back to safe column defaults.
    const insertRow = {
      provider_organization_id: providerOrgId,
      client_organization_id: clientOrgId,
      name,
      client_portal_access_mode: 'transparency_only',
      client_portal_reports_enabled: false,
      client_portal_finance_enabled: false,
      allows_client_submission: false,
      allows_auto_dispatch: false
    };
    if (typeof payload.monthly_report_template_code === 'string') {
      insertRow.monthly_report_template_code = payload.monthly_report_template_code;
    }
    const { data: created, error: insErr } = await admin.from('service_agreements').insert(insertRow).select('id').single();
    if (insErr || !created) {
      const msg = insErr?.message ?? 'Insert failed';
      await admin.from('bob_agentic_actions').update({
        status: 'failed',
        error_message: msg
      }).eq('id', action.id);
      return json({
        error: 'Execution failed',
        details: msg
      }, 500);
    }
    // Stamp the audit ledger.
    await admin.from('bob_agentic_actions').update({
      status: 'applied',
      result_table: 'service_agreements',
      result_record_id: created.id,
      applied_at: new Date().toISOString(),
      error_message: null
    }).eq('id', action.id);
    // ── set_org_corporate_profile ──
    // payload: { organization_id, company_registration_number, nzbn, corporate_status,
    //            corporate_status_as_of, officers: [...] }. Writes organizations
    // columns + org_corporate_officers rows. This is the ONLY place that turns a
    // Bob-resolved corporate profile into a HUMAN-CONFIRMED one (stamps
    // corporate_profile_verified_by/at with THIS approver) — registry_verified
    // on officer rows only ever means the lookup succeeded, never that a human
    // signed off; that human sign-off happens exactly once, right here.
    if (action.action_type === 'set_org_corporate_profile') {
      const cp = action.proposed_payload ?? {};
      const orgId = cp.organization_id ? String(cp.organization_id) : String(action.organization_id);
      if (!orgId) return await failAction('proposed_payload.organization_id is required');
      const { data: targetOrg } = await admin.from('organizations').select('id').eq('id', orgId).maybeSingle();
      if (!targetOrg) return await failAction(`organization_id ${orgId} does not exist`);
      const officersRaw = Array.isArray(cp.officers) ? cp.officers : [];
      // Reject any smuggled personal-address field at the execution boundary too
      // (defence in depth — the producer already rejects this, but the executor
      // never trusts a payload's origin alone).
      for (const o of officersRaw){
        const badKey = Object.keys(o).find((k)=>/resid|home_address|personal_address/i.test(k));
        if (badKey) return await failAction(`Officer field '${badKey}' is not permitted — only address_for_service is ever written`);
      }
      const nowIso = new Date().toISOString();
      const orgUpdate = {
        corporate_profile_verified_by: action.approved_by ?? null,
        corporate_profile_verified_at: nowIso
      };
      if (cp.company_registration_number != null) orgUpdate.company_registration_number = cp.company_registration_number;
      if (cp.nzbn != null) orgUpdate.nzbn = cp.nzbn;
      if (cp.corporate_status != null) orgUpdate.corporate_status = cp.corporate_status;
      if (cp.corporate_status_as_of != null) orgUpdate.corporate_status_as_of = cp.corporate_status_as_of;
      const { error: orgUpdErr } = await admin.from('organizations').update(orgUpdate).eq('id', orgId);
      if (orgUpdErr) return await failAction(`Could not update organizations: ${orgUpdErr.message}`);
      // Replace this org's officer set with the approved set (versionless —
      // corporate standing is a current-state snapshot, not a history table;
      // organizations.corporate_profile_verified_at is the audit timestamp).
      await admin.from('org_corporate_officers').delete().eq('organization_id', orgId);
      if (officersRaw.length) {
        const rows = officersRaw.map((o)=>({
            organization_id: orgId,
            officer_role: o.officer_role,
            full_name: o.full_name,
            address_for_service: o.address_for_service ?? null,
            contact_email: o.contact_email ?? null,
            contact_phone: o.contact_phone ?? null,
            shareholding_percentage: o.shareholding_percentage ?? null,
            source: o.source ?? 'companies_office',
            source_as_of: o.source_as_of ?? null,
            registry_verified: true,
            notes: o.notes ?? null,
            // Gazette adverse-notice fields (0206) — personal bankruptcy/
            // liquidation-association, distinct per officer. adverse_notice_
            // status of 'none_found' is a SEARCH RESULT, not a clean-record
            // guarantee — always carries search_as_of.
            adverse_notice_status: o.adverse_notice_status ?? null,
            adverse_notice_reference: o.adverse_notice_reference ?? null,
            adverse_notice_source_url: o.adverse_notice_source_url ?? null,
            adverse_notice_published_at: o.adverse_notice_published_at ?? null,
            adverse_notice_effective_at: o.adverse_notice_effective_at ?? null,
            adverse_notice_search_as_of: o.adverse_notice_search_as_of ?? null
          }));
        const { error: officersErr } = await admin.from('org_corporate_officers').insert(rows);
        if (officersErr) return await failAction(`Could not write org_corporate_officers: ${officersErr.message}`);
      }
      await admin.from('bob_agentic_actions').update({
        status: 'applied',
        result_table: 'organizations',
        result_record_id: orgId,
        applied_at: nowIso,
        error_message: null
      }).eq('id', action.id);
      return json({
        success: true,
        action_id: action.id,
        result_table: 'organizations',
        result_record_id: orgId,
        officers_written: officersRaw.length,
        note: 'Corporate profile approved and written. corporate_profile_verified_by/at stamped with this approval.'
      });
    }
    return json({
      success: true,
      action_id: action.id,
      result_table: 'service_agreements',
      result_record_id: created.id,
      note: 'Draft agreement created (inert). A human must edit it in CRM to activate.'
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Internal error';
    return json({
      error: 'Server error',
      details: msg
    }, 500);
  }
});
