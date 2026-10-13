import { authorizePlatformDiagnostic } from '../_shared/platformDiagnosticAuth.ts';

const FN = 'bob-email-view';
const MAILGUN_API_KEY = Deno.env.get('MAILGUN_API_KEY');
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
const AWS_ACCESS_KEY_ID = Deno.env.get('AWS_ACCESS_KEY_ID');
const AWS_SECRET_ACCESS_KEY = Deno.env.get('AWS_SECRET_ACCESS_KEY');
const RELAY_BASE = Deno.env.get('STACK_RELAY_BASE_URL');
const RELAY_TOKEN = Deno.env.get('STACK_RELAY_TOKEN');
const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const RAW = Deno.env.get('SUPABASE_SECRET_KEYS');
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
function route(req) {
  const p = new URL(req.url).pathname;
  const a = p.split('/').filter(Boolean);
  if (a[0] === FN) return '/' + a.slice(1).join('/');
  const i = a.indexOf(FN);
  return i >= 0 ? '/' + a.slice(i + 1).join('/') : p;
}
function redactEmail(value) {
  return String(value ?? '').replace(/\b[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})\b/gi, '[redacted]@$1');
}
function redactValue(value) {
  if (value == null) return value;
  if (typeof value === 'string') return redactEmail(value);
  if (Array.isArray(value)) return value.slice(0, 50).map(redactValue);
  if (typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = /(token|password|secret|authorization|api[_-]?key|credential)/i.test(key)
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
        target: 'email',
        endpoint: ep,
        result: res
      }
    })
  });
  if (!response.ok) throw new Error(`Audit write failed (${response.status})`);
}
async function relay(path) {
  if (!RELAY_BASE || !RELAY_TOKEN) return {
    ok: false,
    status: 503,
    body: {
      code: 'NO_RELAY'
    }
  };
  const r = await fetch(`${RELAY_BASE}${path}`, {
    headers: {
      authorization: `Bearer ${RELAY_TOKEN}`
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
async function fromResend(endpoint) {
  const r = await fetch(`https://api.resend.com/${endpoint}`, {
    headers: {
      authorization: `Bearer ${RESEND_API_KEY}`
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
  const ep = route(req);
  const allowed = new Set(['/health', '/domains', '/delivery/recent', '/inbound/status', '/logs/recent']);
  if (!allowed.has(ep)) return json(404, {
    ok: false,
    code: 'NOT_FOUND'
  });
  try {
    if (ep === '/health') {
      await audit(caller.user.id, ep, 'ok');
      return json(200, {
        ok: true,
        service: FN,
        provider: RESEND_API_KEY ? 'resend' : MAILGUN_API_KEY ? 'mailgun' : AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY ? 'ses' : 'relay'
      });
    }
    if (RESEND_API_KEY) {
      if (ep === '/domains') {
        const x = await fromResend('domains');
        await audit(caller.user.id, ep, x.ok ? 'ok' : 'error');
        return json(x.status, {
          ok: x.ok,
          data: (x.body?.data ?? []).map((d)=>({
              id: d.id,
              name: d.name,
              status: d.status,
              created_at: d.created_at
            }))
        });
      }
      if (ep === '/delivery/recent') {
        const x = await fromResend('emails?limit=20');
        await audit(caller.user.id, ep, x.ok ? 'ok' : 'error');
        return json(x.status, {
          ok: x.ok,
          data: (x.body?.data ?? []).map((m)=>({
              id: m.id,
              created_at: m.created_at,
              recipients: Array.isArray(m.to) ? m.to.length : m.to ? 1 : 0,
              status: m.last_event
            }))
        });
      }
      if (ep === '/inbound/status') {
        await audit(caller.user.id, ep, 'ok');
        return json(200, {
          ok: true,
          data: {
            supported: false,
            provider: 'resend'
          }
        });
      }
      if (ep === '/logs/recent') {
        const x = await fromResend('emails?limit=20');
        await audit(caller.user.id, ep, x.ok ? 'ok' : 'error');
        return json(x.status, {
          ok: x.ok,
          data: (x.body?.data ?? []).map((m)=>({
              id: m.id,
              status: m.last_event,
              created_at: m.created_at
            }))
        });
      }
    }
    const y = await relay(ep);
    await audit(caller.user.id, ep, y.ok ? 'ok' : 'error');
    if (!y.ok) return json(y.status, {
      ok: false,
      code: 'UPSTREAM_UNAVAILABLE'
    });
    return json(200, {
      ok: true,
      data: redactValue(y.body)
    });
  } catch (error) {
    console.error(`[${FN}] diagnostic failed`, error);
    return json(500, {
      ok: false,
      code: 'INTERNAL_ERROR'
    });
  }
});
