import { authorizePlatformDiagnostic } from '../_shared/platformDiagnosticAuth.ts';

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
function redactValue(value) {
  if (value == null) return value;
  if (typeof value === 'string') {
    return value.replace(/(bearer\s+)[^\s]+/gi, '$1[REDACTED]');
  }
  if (Array.isArray(value)) return value.slice(0, 100).map(redactValue);
  if (typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = /(token|password|secret|authorization|credential|value)/i.test(key)
        ? '[REDACTED]'
        : redactValue(item);
    }
    return out;
  }
  return value;
}
function routeOf(req) {
  const p = new URL(req.url).pathname;
  const a = p.split('/').filter(Boolean);
  if (a[0] === FN) return '/' + a.slice(1).join('/');
  const i = a.indexOf(FN);
  return i >= 0 ? '/' + a.slice(i + 1).join('/') : p;
}
async function audit(actorId, endpoint, result) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/audit_log`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SECRET_KEY,
      authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
      'content-type': 'application/json',
      prefer: 'return=minimal'
    },
    body: JSON.stringify({
      actor_user_id: actorId,
      action: FN,
      target_table: 'edge_function',
      metadata: {
        target: 'vercel',
        endpoint,
        result
      }
    })
  });
  if (!response.ok) throw new Error(`Audit write failed (${response.status})`);
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
  const caller = await authorizePlatformDiagnostic(req, true);
  if (!caller) return json(403, {
    ok: false,
    code: 'FORBIDDEN'
  });
  const route = routeOf(req);
  if (req.method !== 'GET') return json(405, {
    ok: false,
    code: 'METHOD_NOT_ALLOWED'
  });
  try {
    if (route === '/health') {
      await audit(caller.user.id, route, 'ok');
      return json(200, {
        ok: true,
        service: FN
      });
    }
    if (route === '/projects') {
      const x = await vc('/v9/projects?limit=50');
      await audit(caller.user.id, route, x.ok ? 'ok' : 'error');
      return json(x.status, {
        ok: x.ok,
        data: redactValue(x.body?.projects ?? [])
      });
    }
    if (route === '/deployments') {
      const x = await vc('/v6/deployments?limit=30');
      await audit(caller.user.id, route, x.ok ? 'ok' : 'error');
      return json(x.status, {
        ok: x.ok,
        data: redactValue(x.body?.deployments ?? [])
      });
    }
    if (route === '/deployments/failed') {
      const x = await vc('/v6/deployments?limit=30&state=ERROR');
      await audit(caller.user.id, route, x.ok ? 'ok' : 'error');
      return json(x.status, {
        ok: x.ok,
        data: redactValue(x.body?.deployments ?? [])
      });
    }
    if (route === '/domains') {
      const x = await vc('/v5/domains?limit=50');
      await audit(caller.user.id, route, x.ok ? 'ok' : 'error');
      return json(x.status, {
        ok: x.ok,
        data: redactValue(x.body?.domains ?? [])
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
      await audit(caller.user.id, route, x.ok ? 'ok' : 'error');
      return json(x.status, {
        ok: x.ok,
        data: names
      });
    }
    return json(404, {
      ok: false,
      code: 'NOT_FOUND'
    });
  } catch (error) {
    console.error(`[${FN}] diagnostic failed`, error);
    return json(500, {
      ok: false,
      code: 'INTERNAL_ERROR'
    });
  }
});
