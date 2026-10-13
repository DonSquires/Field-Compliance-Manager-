import { authorizePlatformDiagnostic } from '../_shared/platformDiagnosticAuth.ts';

const FN = 'bob-ptt-view';
const BASE = Deno.env.get('PTT_RELAY_BASE_URL') || Deno.env.get('STACK_RELAY_BASE_URL');
const TOKEN = Deno.env.get('PTT_RELAY_TOKEN') || Deno.env.get('STACK_RELAY_TOKEN');
const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const RAW = Deno.env.get('SUPABASE_SECRET_KEYS');
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
if (!SUPABASE_URL) throw new Error('SUPABASE_URL is required');
const SB = RAW ? JSON.parse(RAW).default : SERVICE_ROLE_KEY;
if (!SB) throw new Error('A Supabase service key is required');
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
function redactValue(value) {
  if (value == null) return value;
  if (typeof value === 'string') {
    return value
      .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED_EMAIL]')
      .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[REDACTED_IP]');
  }
  if (Array.isArray(value)) return value.slice(0, 50).map(redactValue);
  if (typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = /(token|password|secret|authorization|phone|email|user|member)/i.test(key)
        ? '[REDACTED]'
        : redactValue(item);
    }
    return out;
  }
  return value;
}
async function audit(actorId, ep, res) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/audit_log`, {
    method: 'POST',
    headers: {
      apikey: SB,
      authorization: `Bearer ${SB}`,
      'content-type': 'application/json',
      prefer: 'return=minimal'
    },
    body: JSON.stringify({
      actor_user_id: actorId,
      action: FN,
      target_table: 'edge_function',
      metadata: {
        target: 'ptt',
        endpoint: ep,
        result: res
      }
    })
  });
  if (!response.ok) throw new Error(`Audit write failed (${response.status})`);
}
async function relay(path) {
  if (!BASE || !TOKEN) return {
    ok: false,
    status: 503,
    body: {
      code: 'NO_RELAY'
    }
  };
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
  const caller = await authorizePlatformDiagnostic(req, true);
  if (!caller) return json(403, {
    ok: false,
    code: 'FORBIDDEN'
  });
  if (req.method !== 'GET') return json(405, {
    ok: false,
    code: 'METHOD_NOT_ALLOWED'
  });
  const ep = rt(req);
  try {
    if (ep === '/health') {
      await audit(caller.user.id, ep, 'ok');
      return json(200, {
        ok: true,
        service: FN,
        relayConfigured: Boolean(BASE && TOKEN)
      });
    }
    if (ep === '/connections') {
      const x = await relay('/connections');
      await audit(caller.user.id, ep, x.ok ? 'ok' : 'error');
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
      await audit(caller.user.id, ep, x.ok ? 'ok' : 'error');
      return json(x.status, {
        ok: x.ok,
        data: redactValue((x.body?.rooms ?? []).slice(0, 50))
      });
    }
    if (ep === '/turn/status') {
      const x = await relay('/turn/status');
      await audit(caller.user.id, ep, x.ok ? 'ok' : 'error');
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
      await audit(caller.user.id, ep, x.ok ? 'ok' : 'error');
      return json(x.status, {
        ok: x.ok,
        data: redactValue((x.body?.errors ?? []).slice(0, 30))
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
