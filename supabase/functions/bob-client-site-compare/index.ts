/**
 * bob-client-site-compare — CRM client/site existence and dataset comparison
 *
 * Purpose:
 *   Let Bob compare extracted/staged client/site candidates against canonical
 *   CRM orgs and client_sites before any create/upsert proposal.
 *
 * Auth:
 *   Supabase JWT required. Caller must be admin/master/grand_master.
 */ import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};
const CAN_COMPARE = new Set([
  'grand_master',
  'master',
  'admin',
  'admin_officer'
]);
const ALLOWED_STAGING_TABLES = new Set([
  'fs_nelson_clients_clean'
]);
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS,
      'Content-Type': 'application/json'
    }
  });
}
function norm(value) {
  return String(value ?? '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function addressKey(c) {
  return [
    c.address,
    c.suburb,
    c.postcode
  ].map(norm).filter(Boolean).join('|');
}
function similarity(a, b) {
  const aa = new Set(norm(a).split(' ').filter(Boolean));
  const bb = new Set(norm(b).split(' ').filter(Boolean));
  if (!aa.size || !bb.size) return 0;
  let common = 0;
  for (const token of aa)if (bb.has(token)) common++;
  return common / Math.max(aa.size, bb.size);
}
serve(async (req)=>{
  if (req.method === 'OPTIONS') return new Response('ok', {
    headers: CORS
  });
  if (req.method !== 'POST') return json({
    error: 'POST required'
  }, 405);
  try {
    const authHeader = req.headers.get('Authorization') ?? '';
    if (!authHeader) return json({
      error: 'Unauthorized'
    }, 401);
    const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: {
        headers: {
          Authorization: authHeader
        }
      }
    });
    const { data: { user }, error: authErr } = await callerClient.auth.getUser();
    if (authErr || !user) return json({
      error: 'Unauthorized'
    }, 401);
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: profile } = await admin.from('user_profiles').select('id, role, organization_id').eq('id', user.id).single();
    if (!profile || !CAN_COMPARE.has(String(profile.role))) {
      return json({
        error: 'Forbidden: admin/master/grand_master required'
      }, 403);
    }
    const body = await req.json();
    // C1b-2: the conductor (user boundary) passes the caller's authorised org
    // scope. Own-org rows are returned in full; anything outside scope is reduced
    // to a de-identified signal (a match exists, but no name/address/owner id).
    // cross_org_unrestricted is true ONLY for admiral (grand_master), who owns
    // the whole build and sees every org in full.
    const crossOrgUnrestricted = body.cross_org_unrestricted === true;
    const scopeOrgIds = new Set((Array.isArray(body.scope_org_ids) ? body.scope_org_ids : []).map((s)=>String(s)));
    const inScope = (orgId)=>crossOrgUnrestricted || scopeOrgIds.size === 0 || scopeOrgIds.has(String(orgId ?? ''));
    let candidates = Array.isArray(body.candidates) ? body.candidates : [];
    if (body.staging_table) {
      const staging = norm(body.staging_table).replace(/ /g, '_');
      if (!ALLOWED_STAGING_TABLES.has(staging)) {
        return json({
          error: 'Unsupported staging_table',
          supported: [
            ...ALLOWED_STAGING_TABLES
          ]
        }, 422);
      }
      // ATLAS READS: fs_nelson_clients_clean
      const { data: staged, error: stagedErr } = await admin.from(staging).select('client_id, client_name, client_address, client_suburb, client_postcode').limit(Math.min(Math.max(body.limit ?? 5000, 1), 10000));
      if (stagedErr) throw new Error(stagedErr.message);
      candidates = (staged ?? []).map((r)=>({
          client_id: r.client_id ?? undefined,
          client_name: r.client_name ?? undefined,
          site_name: r.client_name ?? undefined,
          address: r.client_address ?? undefined,
          suburb: r.client_suburb ?? undefined,
          postcode: r.client_postcode ?? undefined
        }));
    }
    const cleaned = candidates.map((c)=>({
        ...c,
        client_name: c.client_name?.trim(),
        address: c.address?.trim()
      })).filter((c)=>c.client_name || c.address);
    if (!cleaned.length) return json({
      error: 'No candidates supplied'
    }, 400);
    const { data: orgs, error: orgErr } = await admin.from('organizations').select('id, name, organization_type, parent_organization_id').in('organization_type', [
      'client',
      'government',
      'private_enterprise',
      'service_provider',
      'branch'
    ]);
    if (orgErr) throw new Error(orgErr.message);
    const { data: sites, error: siteErr } = await admin.from('client_sites').select('id, name, address, client_organization_id, address_match_key');
    if (siteErr) throw new Error(siteErr.message);
    const orgRows = orgs ?? [];
    const siteRows = sites ?? [];
    // Redaction helpers. When a match falls outside the caller's authorised org
    // scope, we still return the USEFUL signal (a match exists, and its strength)
    // but strip all identifying fields (name, address, owner org id). This lets
    // Bob warn "a likely duplicate exists outside your organisations" without
    // leaking another org's private data. Own-org matches are returned in full.
    const orgInScope = (o)=>inScope(o.id);
    const siteInScope = (s)=>inScope(s.client_organization_id);
    const results = cleaned.map((candidate)=>{
      const cName = candidate.client_name ?? '';
      const cAddrKey = addressKey(candidate);
      const exactClient = orgRows.find((o)=>norm(o.name) === norm(cName));
      const likelyClients = orgRows.map((o)=>({
          id: o.id,
          name: o.name,
          type: o.organization_type,
          score: similarity(cName, String(o.name ?? ''))
        })).filter((m)=>m.score >= 0.55 && (!exactClient || m.id !== exactClient.id)).sort((a, b)=>b.score - a.score).slice(0, 5);
      const exactSite = siteRows.find((s)=>{
        const key = String(s.address_match_key ?? '').trim();
        const siteKey = norm(s.address);
        return Boolean(cAddrKey) && (key === cAddrKey || siteKey && siteKey === cAddrKey);
      });
      const likelySites = siteRows.map((s)=>({
          id: s.id,
          name: s.name,
          address: s.address,
          client_organization_id: s.client_organization_id,
          score: Math.max(similarity(candidate.address ?? '', String(s.address ?? '')), similarity(cName, String(s.name ?? '')))
        })).filter((m)=>m.score >= 0.6 && (!exactSite || m.id !== exactSite.id)).sort((a, b)=>b.score - a.score).slice(0, 5);
      return {
        candidate,
        exact_client: exactClient ? orgInScope(exactClient) ? {
          id: exactClient.id,
          name: exactClient.name,
          type: exactClient.organization_type
        } : {
          out_of_scope: true,
          signal: 'exact_match_exists_outside_your_organisations'
        } : null,
        likely_clients: likelyClients.map((m)=>{
          const row = orgRows.find((o)=>o.id === m.id);
          return row && orgInScope(row) ? m : {
            out_of_scope: true,
            score: m.score,
            signal: 'likely_duplicate_outside_your_organisations'
          };
        }),
        exact_site: exactSite ? siteInScope(exactSite) ? {
          id: exactSite.id,
          name: exactSite.name,
          address: exactSite.address,
          client_organization_id: exactSite.client_organization_id
        } : {
          out_of_scope: true,
          signal: 'exact_site_exists_outside_your_organisations'
        } : null,
        likely_sites: likelySites.map((m)=>{
          const row = siteRows.find((s)=>s.id === m.id);
          return row && siteInScope(row) ? m : {
            out_of_scope: true,
            score: m.score,
            signal: 'likely_site_duplicate_outside_your_organisations'
          };
        }),
        recommendation: exactClient && exactSite ? 'already_exists' : exactClient && !exactSite ? 'create_site_under_existing_client' : !exactClient && exactSite ? 'review_site_owner_or_duplicate_client' : likelyClients.length || likelySites.length ? 'review_possible_duplicate' : 'create_client_and_site'
      };
    });
    const summary = {
      total_candidates: results.length,
      already_exists: results.filter((r)=>r.recommendation === 'already_exists').length,
      create_site_under_existing_client: results.filter((r)=>r.recommendation === 'create_site_under_existing_client').length,
      review_site_owner_or_duplicate_client: results.filter((r)=>r.recommendation === 'review_site_owner_or_duplicate_client').length,
      review_possible_duplicate: results.filter((r)=>r.recommendation === 'review_possible_duplicate').length,
      create_client_and_site: results.filter((r)=>r.recommendation === 'create_client_and_site').length
    };
    return json({
      success: true,
      summary,
      results: results.slice(0, Math.min(body.limit ?? 200, 1000))
    });
  } catch (err) {
    console.error('[bob-client-site-compare] error:', err);
    return json({
      error: 'Client/site comparison failed',
      detail: err instanceof Error ? err.message : String(err)
    }, 500);
  }
});
