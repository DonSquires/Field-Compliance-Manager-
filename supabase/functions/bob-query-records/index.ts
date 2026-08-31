// Live record lookup for Bob's `query_records` tool. The response fields match
// `onspace-ai-chat/query-records-conductor.ts::renderQueryResults`:
//   find_org|get_org|list_orgs -> name, organization_type, id
//   list_sites                 -> name, address, id
//   list_routes                -> route_code, name, route_type, id
//   list_zones                 -> name, rule_type, has_boundary, id
//   find_user                  -> display_name, role   (Tier-0 person policy)
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { CAN_QUERY, resolveEffectiveRole } from '../_shared/auth.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' }
  });

/** Retryable error: Bob's self-heal loop may correct the call and try again. */
const retryable = (error, detail) =>
  json({ error, detail: detail ?? undefined, retryable: true, permanent: false }, 400);

const VALID_QUERY_TYPES = new Set([
  'find_org',
  'get_org',
  'list_orgs',
  'list_sites',
  'list_routes',
  'list_zones',
  'find_user'
]);

/**
 * Sanitise a user-supplied search term before it becomes a PostgREST `ilike`
 * pattern. Strips the characters that terminate/alter a PostgREST filter
 * expression, and escapes the LIKE wildcards so a search for "50%" cannot
 * turn into a match-everything scan.
 */
function sanitizeSearchTerm(raw) {
  return String(raw ?? '')
    .replace(/[,()*"\\]/g, ' ')
    .replace(/[%_]/g, (m) => `\\${m}`)
    .trim()
    .slice(0, 120);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST required' }, 405);

  const requestId = req.headers.get('x-request-id') ?? crypto.randomUUID();

  try {
    const authHeader = req.headers.get('Authorization') ?? '';
    if (!authHeader) return json({ error: 'Unauthorized' }, 401);

    const caller = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } }
    });
    const { data: { user }, error: authErr } = await caller.auth.getUser();
    if (authErr || !user) return json({ error: 'Unauthorized' }, 401);

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: profile } = await admin
      .from('user_profiles')
      .select('role, organization_id')
      .eq('id', user.id)
      .single();

    const role = resolveEffectiveRole(user.email ?? '', profile?.role ?? '');
    if (!CAN_QUERY.has(role)) {
      // Permanent: a role change is not something Bob can self-correct by
      // retrying, so terminate rather than invite a retry loop.
      return json(
        {
          error: 'Forbidden: your role is not permitted to query records.',
          permanent: true,
          retryable: false
        },
        403
      );
    }

    const body = await req.json().catch(() => ({}));
    const query = String(body.query ?? body.q ?? '').trim();
    const args = body.args && typeof body.args === 'object' ? body.args : {};
    const limit = Math.min(Math.max(Number(body.limit ?? 25) || 25, 1), 100);

    if (!VALID_QUERY_TYPES.has(query)) {
      return retryable(
        `Unknown query type "${query || '(none)'}".`,
        `Valid query types: ${[...VALID_QUERY_TYPES].join(', ')}. Call shape: { query: <type>, args: { name: "<search term>" } }.`
      );
    }

    // ── Org scoping ─────────────────────────────────────────────────────────
    // #322: Bob reads freely when cross_org_unrestricted is set. Otherwise the
    // read is confined to the caller's authorised org list.
    const crossOrg = body.cross_org_unrestricted === true;
    const scopeOrgIds = Array.isArray(body.scope_org_ids)
      ? body.scope_org_ids.filter((id) => typeof id === 'string' && UUID_RE.test(id))
      : [];
    const applyScope = (q, column) => {
      if (crossOrg) return q;
      if (scopeOrgIds.length) return q.in(column, scopeOrgIds);
      if (profile?.organization_id) return q.eq(column, profile.organization_id);
      return q;
    };

    const searchTerm = sanitizeSearchTerm(args.name ?? args.search ?? args.term ?? '');
    const orgFilter =
      typeof args.organization_id === 'string' && UUID_RE.test(args.organization_id)
        ? args.organization_id
        : null;

    let results = [];

    if (query === 'find_org' || query === 'get_org' || query === 'list_orgs') {
      const cols =
        'id, name, organization_type, organization_level, status, active, parent_organization_id';
      let q = admin.from('organizations').select(cols);

      if (query === 'get_org') {
        const orgId =
          typeof args.id === 'string' && UUID_RE.test(args.id) ? args.id : orgFilter;
        if (orgId) {
          q = q.eq('id', orgId);
        } else if (searchTerm) {
          q = q.ilike('name', `%${searchTerm}%`);
        } else {
          return retryable(
            'get_org needs an organisation id or name.',
            'Call shape: { query: "get_org", args: { id: "<uuid>" } } or { query: "get_org", args: { name: "<org name>" } }.'
          );
        }
      } else if (query === 'find_org') {
        if (!searchTerm) {
          return retryable(
            'find_org needs a search term.',
            'Call shape: { query: "find_org", args: { name: "<org name>" } }. The search term goes in the INNER args object.'
          );
        }
        q = q.ilike('name', `%${searchTerm}%`);
      } else if (searchTerm) {
        q = q.ilike('name', `%${searchTerm}%`);
      }

      q = applyScope(q, 'id').order('name').limit(limit);
      const { data, error } = await q;
      if (error) return json({ error: error.message }, 500);
      results = data ?? [];
    } else if (query === 'list_sites') {
      let q = admin
        .from('client_sites')
        .select(
          'id, name, address, site_code, site_type, active, organization_id, client_organization_id'
        );
      if (searchTerm) q = q.ilike('name', `%${searchTerm}%`);
      if (orgFilter) {
        q = q.or(`organization_id.eq.${orgFilter},client_organization_id.eq.${orgFilter}`);
      } else {
        q = applyScope(q, 'organization_id');
      }
      const { data, error } = await q.order('name').limit(limit);
      if (error) return json({ error: error.message }, 500);
      results = data ?? [];
    } else if (query === 'list_routes') {
      let q = admin
        .from('patrol_routes')
        .select('id, name, route_code, route_type, is_active, organization_id, site_id');
      if (searchTerm) q = q.ilike('name', `%${searchTerm}%`);
      if (orgFilter) q = q.eq('organization_id', orgFilter);
      else q = applyScope(q, 'organization_id');
      if (typeof args.site_id === 'string' && UUID_RE.test(args.site_id)) {
        q = q.eq('site_id', args.site_id);
      }
      const { data, error } = await q.order('name').limit(limit);
      if (error) return json({ error: error.message }, 500);
      results = data ?? [];
    } else if (query === 'list_zones') {
      let q = admin
        .from('location_zones')
        .select('id, name, rule_type, zone_type, is_active, organization_id, site_id, boundary');
      if (searchTerm) q = q.ilike('name', `%${searchTerm}%`);
      if (orgFilter) q = q.eq('organization_id', orgFilter);
      else q = applyScope(q, 'organization_id');
      const { data, error } = await q.order('name').limit(limit);
      if (error) return json({ error: error.message }, 500);
      // The renderer reads `has_boundary`, not the geometry itself. Drop the
      // raw boundary so large geometry payloads never enter the reply path.
      results = (data ?? []).map(({ boundary, ...rest }) => ({
        ...rest,
        has_boundary: boundary !== null && boundary !== undefined
      }));
    } else if (query === 'find_user') {
      // Tier-0 person policy (#323 / #334 F1c): display_name + role only.
      // id / email / phone are never selected, so they cannot be leaked even
      // if a downstream renderer changes.
      if (!searchTerm) {
        return retryable(
          'find_user needs a search term.',
          'Call shape: { query: "find_user", args: { name: "<person name>" } }.'
        );
      }
      let q = admin
        .from('user_profiles')
        .select('display_name, role, organization_id')
        .ilike('display_name', `%${searchTerm}%`);
      q = orgFilter ? q.eq('organization_id', orgFilter) : applyScope(q, 'organization_id');
      const { data, error } = await q.order('display_name').limit(limit);
      if (error) return json({ error: error.message }, 500);
      results = (data ?? []).map((row) => ({
        display_name: row.display_name,
        role: row.role
      }));
    }

    return json({
      ok: true,
      query,
      count: results.length,
      results,
      request_id: requestId
    });
  } catch (err) {
    console.error(
      JSON.stringify({
        event: 'bob_query_records_error',
        request_id: requestId,
        message: err instanceof Error ? err.message : String(err)
      })
    );
    return json({ error: 'query_records failed', request_id: requestId }, 500);
  }
});
