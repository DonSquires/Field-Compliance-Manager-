const FN = 'bob-ptt-view';
const BASE = Deno.env.get('PTT_RELAY_BASE_URL') || Deno.env.get('STACK_RELAY_BASE_URL');
const TOKEN = Deno.env.get('PTT_RELAY_TOKEN') || Deno.env.get('STACK_RELAY_TOKEN');
const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const RAW = Deno.env.get('SUPABASE_SECRET_KEYS');
if (!BASE) throw new Error('PTT_RELAY_BASE_URL or STACK_RELAY_BASE_URL is required');
if (!TOKEN) throw new Error('PTT_RELAY_TOKEN or STACK_RELAY_TOKEN is required');
if (!SUPABASE_URL) throw new Error('SUPABASE_URL is required');
if (!RAW) throw new Error('SUPABASE_SECRET_KEYS is required');
const SB = JSON.parse(RAW).default;
if (!SB) throw new Error('SUPABASE_SECRET_KEYS.default is required');
function json(s, b) {
  return new Response(JSON.stringify(b), {
    status: s,
    headers: {
      'content-type': 'application/json'
    }
  });
}
function rt(req) {
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
      entity_id: 'ptt',
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
  const ep = rt(req);
  try {
    if (ep === '/health') return json(200, {
      ok: true,
      service: FN
    });
    if (ep === '/connections') {
      const x = await relay('/connections');
      await audit(req, ep, x.ok ? 'ok' : 'error');
      return json(x.status, {
        ok: x.ok,
        data: {
          active: x.body?.active ?? 0,
          totalToday: x.body?.totalToday ?? 0
        }
      });
    }
    if (ep === '/rooms') {
      const x = await relay('/rooms');
      await audit(req, ep, x.ok ? 'ok' : 'error');
      return json(x.status, {
        ok: x.ok,
        data: (x.body?.rooms ?? []).slice(0, 50)
      });
    }
    if (ep === '/turn/status') {
      const x = await relay('/turn/status');
      await audit(req, ep, x.ok ? 'ok' : 'error');
      return json(x.status, {
        ok: x.ok,
        data: {
          reachable: x.body?.reachable,
          udp: x.body?.udp,
          tcp: x.body?.tcp,
          tls: x.body?.tls,
          latencyMs: x.body?.latencyMs
        }
      });
    }
    if (ep === '/recent-errors') {
      const x = await relay('/recent-errors');
      await audit(req, ep, x.ok ? 'ok' : 'error');
      return json(x.status, {
        ok: x.ok,
        data: (x.body?.errors ?? []).slice(0, 30)
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
