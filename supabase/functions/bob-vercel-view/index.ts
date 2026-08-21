const FN = 'bob-vercel-view';
const MAX_BODY = 64_000;
const VERCEL_TOKEN = Deno.env.get('VERCEL_TOKEN');
const VERCEL_TEAM_ID = Deno.env.get('VERCEL_TEAM_ID');
const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SECRET_KEYS_RAW = Deno.env.get('SUPABASE_SECRET_KEYS');
if (!VERCEL_TOKEN) throw new Error('VERCEL_TOKEN is required');
if (!VERCEL_TEAM_ID) throw new Error('VERCEL_TEAM_ID is required');
if (!SUPABASE_URL) throw new Error('SUPABASE_URL is required');
if (!SECRET_KEYS_RAW) throw new Error('SUPABASE_SECRET_KEYS is required');
const SUPABASE_SECRET_KEY = JSON.parse(SECRET_KEYS_RAW).default;
if (!SUPABASE_SECRET_KEY) throw new Error('SUPABASE_SECRET_KEYS.default is required');
function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json'
    }
  });
}
function routeOf(req) {
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
async function audit(req, endpoint, result) {
  const c = claims(req);
  await fetch(`${SUPABASE_URL}/rest/v1/audit_log`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SECRET_KEY,
      'content-type': 'application/json',
      prefer: 'return=minimal'
    },
    body: JSON.stringify({
      action: FN,
      entity_type: 'integration',
      entity_id: 'vercel',
      change_summary: JSON.stringify({
        endpoint,
        result,
        actor: c?.sub ?? null
      })
    })
  }).catch(()=>{});
}
async function vc(path) {
  const u = `https://api.vercel.com${path}${path.includes('?') ? '&' : '?'}teamId=${encodeURIComponent(VERCEL_TEAM_ID)}`;
  const r = await fetch(u, {
    headers: {
      authorization: `Bearer ${VERCEL_TOKEN}`
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
  if (Number(req.headers.get('content-length') || 0) > MAX_BODY) return json(413, {
    ok: false,
    code: 'PAYLOAD_TOO_LARGE'
  });
  const c = claims(req);
  if (!c || !isBob(c)) return json(403, {
    ok: false,
    code: 'FORBIDDEN'
  });
  const route = routeOf(req);
  if (req.method !== 'GET') return json(405, {
    ok: false,
    code: 'METHOD_NOT_ALLOWED'
  });
  try {
    if (route === '/health') return json(200, {
      ok: true,
      service: FN
    });
    if (route === '/projects') {
      const x = await vc('/v9/projects?limit=50');
      await audit(req, route, x.ok ? 'ok' : 'error');
      return json(x.status, {
        ok: x.ok,
        data: x.body?.projects ?? []
      });
    }
    if (route === '/deployments') {
      const x = await vc('/v6/deployments?limit=30');
      await audit(req, route, x.ok ? 'ok' : 'error');
      return json(x.status, {
        ok: x.ok,
        data: x.body?.deployments ?? []
      });
    }
    if (route === '/deployments/failed') {
      const x = await vc('/v6/deployments?limit=30&state=ERROR');
      await audit(req, route, x.ok ? 'ok' : 'error');
      return json(x.status, {
        ok: x.ok,
        data: x.body?.deployments ?? []
      });
    }
    if (route === '/domains') {
      const x = await vc('/v5/domains?limit=50');
      await audit(req, route, x.ok ? 'ok' : 'error');
      return json(x.status, {
        ok: x.ok,
        data: x.body?.domains ?? []
      });
    }
    if (route === '/environment-variable-names') {
      const url = new URL(req.url);
      const projectId = url.searchParams.get('projectId');
      if (!projectId) return json(400, {
        ok: false,
        code: 'PROJECT_ID_REQUIRED'
      });
      const x = await vc(`/v10/projects/${encodeURIComponent(projectId)}/env?decrypt=false`);
      const names = (x.body?.envs ?? []).map((e)=>({
          key: e.key,
          target: e.target ?? [],
          type: e.type ?? 'encrypted'
        }));
      await audit(req, route, x.ok ? 'ok' : 'error');
      return json(x.status, {
        ok: x.ok,
        data: names
      });
    }
    return json(404, {
      ok: false,
      code: 'NOT_FOUND'
    });
  } catch  {
    await audit(req, route, 'error');
    return json(500, {
      ok: false,
      code: 'INTERNAL_ERROR'
    });
  }
});
