import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const FN = 'bob-vps-view';
const BASE = Deno.env.get('STACK_RELAY_BASE_URL') ?? Deno.env.get('BOB_CONTROL_PLANE_URL');
const TOKEN = Deno.env.get('STACK_RELAY_TOKEN') ?? Deno.env.get('BOB_ADMIN_TOKEN');
const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const RAW = Deno.env.get('SUPABASE_SECRET_KEYS');
if (!BASE) throw new Error('STACK_RELAY_BASE_URL is required');
if (!TOKEN) throw new Error('STACK_RELAY_TOKEN is required');
if (!SUPABASE_URL) throw new Error('SUPABASE_URL is required');
if (!RAW) throw new Error('SUPABASE_SECRET_KEYS is required');
const SB = JSON.parse(RAW).default;
if (!SB) throw new Error('SUPABASE_SECRET_KEYS.default is required');
const ALLOWED_SERVICES = new Set([
  'app',
  'ptt',
  'nginx',
  'worker',
  'postgres'
]);
function json(s, b) {
  return new Response(JSON.stringify(b), {
    status: s,
    headers: {
      'content-type': 'application/json'
    }
  });
}
function route(req) {
  const p = new URL(req.url).pathname;
  const a = p.split('/').filter(Boolean);
  if (a[0] === FN) return '/' + a.slice(1).join('/');
  const i = a.indexOf(FN);
  return i >= 0 ? '/' + a.slice(i + 1).join('/') : p;
}
function claims(req) {
  const h = req.headers.get('authorization') || '';
  if (!h.startsWith('Bearer ')) return null;
  try {
    return JSON.parse(atob(h.slice(7).split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
  } catch  {
    return null;
  }
}
function isBob(c) {
  return c?.app_metadata?.role === 'bob' || Array.isArray(c?.app_metadata?.roles) && c.app_metadata.roles.includes('bob');
}
async function isVerifiedGrandMaster(req, claimsValue) {
  if (!claimsValue?.sub || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) return false;
  const caller = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: req.headers.get('authorization') ?? '' } } });
  const { data: { user }, error: authError } = await caller.auth.getUser();
  if (authError || !user || user.id !== claimsValue.sub) return false;
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data: profile } = await admin.from('user_profiles').select('role, deactivated_at').eq('id', user.id).maybeSingle();
  return profile?.deactivated_at == null && profile.role === 'grand_master';
}
async function audit(req, ep, res) {
  const c = claims(req);
  await fetch(`${SUPABASE_URL}/rest/v1/audit_log`, {
    method: 'POST',
    headers: {
      apikey: SB,
      'content-type': 'application/json',
      prefer: 'return=minimal'
    },
    body: JSON.stringify({
      action: FN,
      entity_type: 'integration',
      entity_id: 'vps-relay',
      change_summary: JSON.stringify({
        endpoint: ep,
        result: res,
        actor: c?.sub ?? null
      })
    })
  }).catch(()=>{});
}
async function relay(path) {
  const normalizedBase = BASE.replace(/\/+$/, '').replace(/\/api(?:\/bob)?(?:\/builder)?$/, '');
  const urls = [`${normalizedBase}${path}`, `${normalizedBase}/api/bob${path}`, `${normalizedBase}/api/bob/builder${path}`];
  for (const url of urls) {
    const r = await fetch(url, { headers: { authorization: `Bearer ${TOKEN}` } });
    const t = await r.text();
    let b = {};
    try { b = t ? JSON.parse(t) : {}; } catch { b = {}; }
    if (r.status !== 404 || url === urls[urls.length - 1]) return { ok: r.ok, status: r.status, body: b };
  }
  return { ok: false, status: 502, body: {} };
}
Deno.serve(async (req)=>{
  if (req.method === 'OPTIONS') return new Response(null, {
    status: 204
  });
  const c = claims(req);
  if (!c || (!isBob(c) && !(await isVerifiedGrandMaster(req, c)))) return json(403, {
    ok: false,
    code: 'FORBIDDEN'
  });
  if (req.method !== 'GET') return json(405, {
    ok: false,
    code: 'METHOD_NOT_ALLOWED'
  });
  const ep = route(req);
  try {
    if (ep === '/health') {
      return json(200, {
        ok: true,
        service: FN
      });
    }
    if (ep === '/docker/services') {
      const x = await relay('/docker/services');
      await audit(req, ep, x.ok ? 'ok' : 'error');
      return json(x.status, {
        ok: x.ok,
        data: (x.body?.services ?? x.body).slice ? x.body.services.slice(0, 30) : x.body
      });
    }
    if (ep === '/system') {
      const x = await relay('/system');
      await audit(req, ep, x.ok ? 'ok' : 'error');
      return json(x.status, {
        ok: x.ok,
        data: {
          cpu: x.body?.cpu,
          mem: x.body?.mem,
          disk: x.body?.disk,
          uptime: x.body?.uptime
        }
      });
    }
    if (ep === '/assessment') {
      const x = await relay('/assessment');
      await audit(req, ep, x.ok ? 'ok' : 'error');
      return json(x.status, {
        ok: x.ok,
        data: {
          sourceRoot: x.body?.sourceRoot ?? null,
          fileCount: Number(x.body?.fileCount ?? 0),
          packageCount: Array.isArray(x.body?.packages) ? x.body.packages.length : 0,
          compose: Array.isArray(x.body?.compose) ? x.body.compose.slice(0, 20) : [],
          edgeFunctionCount: Array.isArray(x.body?.supabaseEdgeFunctions) ? x.body.supabaseEdgeFunctions.length : 0,
          secretFilesExcluded: x.body?.secretFilesExcluded === true,
        },
      });
    }
    if (ep === '/deployments/recent') {
      const x = await relay('/deployments/recent');
      await audit(req, ep, x.ok ? 'ok' : 'error');
      return json(x.status, {
        ok: x.ok,
        data: (x.body?.deployments ?? []).slice(0, 20)
      });
    }
    if (ep === '/logs/app') {
      const u = new URL(req.url);
      const svc = u.searchParams.get('service') || '';
      const limit = Math.min(Number(u.searchParams.get('limit') || '50'), 200);
      if (!ALLOWED_SERVICES.has(svc)) return json(400, {
        ok: false,
        code: 'SERVICE_NOT_ALLOWED'
      });
      const x = await relay(`/logs/app?service=${encodeURIComponent(svc)}&limit=${limit}`);
      const lines = (x.body?.lines ?? []).slice(0, limit).map((v)=>String(v).slice(0, 500));
      await audit(req, ep, x.ok ? 'ok' : 'error');
      return json(x.status, {
        ok: x.ok,
        data: {
          service: svc,
          count: lines.length,
          lines
        }
      });
    }
    return json(404, {
      ok: false,
      code: 'NOT_FOUND'
    });
  } catch  {
    await audit(req, ep, 'error');
    return json(500, {
      ok: false,
      code: 'INTERNAL_ERROR'
    });
  }
});
