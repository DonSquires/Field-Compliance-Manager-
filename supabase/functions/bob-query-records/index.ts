import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { CAN_QUERY, resolveEffectiveRole } from '../_shared/auth.ts';

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  };
  const QUERY_TYPES = new Set(['find_org', 'get_org', 'list_orgs', 'list_sites', 'list_routes', 'list_zones', 'find_user', 'search_observations', 'safety_workspace']);
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  function json(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
  }

  function boundedLimit(value: unknown) {
    return Math.min(Math.max(Number(value ?? 25), 1), 100);
  }

  function asUuid(value: unknown) {
    const id = String(value ?? '').trim();
    return UUID.test(id) ? id : null;
  }

  serve(async (req) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
    if (req.method !== 'POST') return json({ error: 'POST required' }, 405);
    try {
      const authorization = req.headers.get('Authorization') ?? '';
      if (!authorization) return json({ error: 'Unauthorized' }, 401);

      const caller = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: authorization } } });
      const { data: { user }, error: userError } = await caller.auth.getUser();
      if (userError || !user) return json({ error: 'Unauthorized' }, 401);

      const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
      const { data: profile, error: profileError } = await admin
        .from('user_profiles')
        .select('role, organization_id, deactivated_at')
        .eq('id', user.id)
        .maybeSingle();
      const role = resolveEffectiveRole(user.email, profile?.role);
      if (profileError || !profile || profile.deactivated_at || !CAN_QUERY.has(role)) {
        return json({ error: 'Forbidden: operational record lookup is not available for this account', permanent: true, retryable: false }, 403);
      }

      const body = await req.json();
      const query = String(body.query ?? '').trim();
      const args = body.args && typeof body.args === 'object' ? body.args : {};
      const limit = boundedLimit(body.limit);
      if (!QUERY_TYPES.has(query)) return json({ error: 'Unsupported record lookup', supported: [...QUERY_TYPES] }, 422);

      // Grand masters can inspect the full operational terrain. Every other
      // caller is restricted to their tenancy anchor regardless of request body.
      const unrestricted = role === 'grand_master';
      const orgId = asUuid(args.organization_id ?? args.org_id ?? args.id);
      const scopedOrgId = unrestricted ? orgId : profile.organization_id;
      if (!unrestricted && !scopedOrgId) return json({ error: 'No organization scope is available', permanent: true, retryable: false }, 403);

      if (query === 'safety_workspace') {
        const targetOrg = orgId ?? scopedOrgId;
        if (!targetOrg) return json({ error: 'An explicit keeping organisation is required' }, 422);
        const locationId = args.location_id ? asUuid(args.location_id) : null;
        if (args.location_id && !locationId) return json({ error: 'location_id must be a UUID' }, 422);
        // ATLAS READS: get_safety_review_workspace
        const { data, error } = await caller.rpc('get_safety_review_workspace', {
          p_organization_id: targetOrg, p_location_id: locationId,
        });
        if (error) return json({ error: error.message, permanent: true, retryable: false }, 403);
        const results = [
          ...(data?.hazards ?? []).map((h: Record<string, unknown>) => ({
            id: h.id, name: h.title, record_type: 'place_hazard', version: h.version,
            risk_owner_id: h.risk_owner_id, review_due: h.review_due, location_id: h.location_id,
            controls: h.controls, control_levels: h.control_levels,
          })),
          ...(data?.reviews ?? []).map((r: Record<string, unknown>) => ({
            id: r.id, name: r.title, record_type: 'safety_review', status: r.status,
            location_id: r.location_id, field_report_id: r.field_report_id, incident_id: r.incident_id,
            assessment_id: r.assessment_id, investigation_id: r.investigation_id,
          })),
        ];
        return json({ results: results.slice(0, limit), total: results.length, truncated: results.length > limit,
          human_action_required: 'Officers sign their own task assessments; supervisors review findings and corrective actions in Field reports / Safety reviews.' });
      }

      if (query === 'find_org') {
        const name = String(args.name ?? args.search ?? '').trim();
        if (!name) return json({ error: 'An organization name is required' }, 422);
        let request = admin.from('organizations').select('id, name, organization_type, parent_organization_id, active, status').ilike('name', `%${name}%`).order('name').limit(limit);
        if (!unrestricted) request = request.eq('id', scopedOrgId);
        const { data, error } = await request;
        if (error) throw error;
        return json({ results: data ?? [] });
      }

      if (query === 'get_org') {
        const targetId = orgId;
        if (!targetId) return json({ error: 'An organization ID is required' }, 422);
        if (!unrestricted && targetId !== scopedOrgId) return json({ error: 'That organization is outside your operational scope', permanent: true, retryable: false }, 403);
        const { data, error } = await admin.from('organizations').select('id, name, organization_type, parent_organization_id, active, status').eq('id', targetId).maybeSingle();
        if (error) throw error;
        return json({ results: data ? [data] : [] });
      }

      if (query === 'list_orgs') {
        const parentId = asUuid(args.parent_id);
        let request = admin.from('organizations').select('id, name, organization_type, parent_organization_id, active, status').order('name').limit(limit);
        if (parentId) request = request.eq('parent_organization_id', parentId);
        if (!unrestricted) request = request.eq('id', scopedOrgId);
        const { data, error } = await request;
        if (error) throw error;
        return json({ results: data ?? [] });
      }

      if (query === 'list_sites') {
        if (!scopedOrgId) return json({ error: 'An organization ID is required' }, 422);
        const { data, error } = await admin.from('client_sites').select('id, client_organization_id, location_id, name, address, active, boundary_status, boundary_verification').eq('client_organization_id', scopedOrgId).order('name').limit(limit);
        if (error) throw error;
        return json({ results: data ?? [] });
      }

      if (query === 'list_routes') {
        if (!scopedOrgId) return json({ error: 'An organization ID is required' }, 422);
        const { data, error } = await admin.from('patrol_routes').select('id, organization_id, name, route_code, route_type, is_active, checkpoint_mode').eq('organization_id', scopedOrgId).order('name').limit(limit);
        if (error) throw error;
        return json({ results: data ?? [] });
      }

      if (query === 'list_zones') {
        if (!scopedOrgId) return json({ error: 'An organization ID is required' }, 422);
        const { data, error } = await admin.from('location_zones').select('id, organization_id, name, rule_type, is_active, boundary_status, boundary_verification').eq('organization_id', scopedOrgId).order('name').limit(limit);
        if (error) throw error;
        return json({ results: (data ?? []).map((zone) => ({ ...zone, has_boundary: zone.boundary_status === 'authoritative' || zone.boundary_verification === 'verified' })) });
      }

      if (query === 'search_observations') {
        if (!scopedOrgId) return json({ error: 'An organization ID is required' }, 422);
        const uuidArg = (key: string) => asUuid(args[key]);
        const { data, error } = await admin.rpc('search_observations', {
          p_organization_id: scopedOrgId,
          p_search: String(args.search ?? args.name ?? args.term ?? '').trim() || null,
          p_site_id: uuidArg('site_id'),
          p_zone_id: uuidArg('zone_id'),
          p_location_id: uuidArg('location_id'),
          p_vehicle_id: uuidArg('vehicle_id'),
          p_person_id: uuidArg('person_id'),
          p_incident_id: uuidArg('incident_id'),
          p_poi: typeof args.poi === 'boolean' ? args.poi : null,
          p_loi: typeof args.loi === 'boolean' ? args.loi : null,
          p_limit: limit,
        });
        if (error) throw error;
        return json({ results: data ?? [] });
      }

      const name = String(args.name ?? args.search ?? '').trim();
      if (!name) return json({ error: 'A person name is required' }, 422);
      let request = admin.from('user_profiles').select('display_name, role, organization_id').ilike('display_name', `%${name}%`).is('deactivated_at', null).order('display_name').limit(limit);
      if (!unrestricted) request = request.eq('organization_id', scopedOrgId);
      const { data, error } = await request;
      if (error) throw error;
      return json({ results: data ?? [] });
    } catch (error) {
      console.error('[bob-query-records]', error);
      return json({ error: 'Record lookup failed' }, 500);
    }
  });
