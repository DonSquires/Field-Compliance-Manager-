const FN = 'bob-vps-view';
const BASE = Deno.env.get('STACK_RELAY_BASE_URL');
const TOKEN = Deno.env.get('STACK_RELAY_TOKEN');
const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
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
  const r = await fetch(`${BASE}${path}`, {
    headers: {
      authorization: `Bearer ${TOKEN}`
    }
  });
  const t = await r.text();
  let b = {};
  try {
    b = t ? JSON.parse(t) : {};
  } catch  {
    b = {};
  }
  ;
  return {
    ok: r.ok,
    status: r.status,
    body: b
  };
}
Deno.serve(async (req)=>{
  if (req.method === 'OPTIONS') return new Response(null, {
    status: 204
  });
  const c = claims(req);
  if (!c || !isBob(c)) return json(403, {
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
