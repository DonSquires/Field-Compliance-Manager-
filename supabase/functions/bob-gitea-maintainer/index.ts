const FN = 'bob-gitea-maintainer';
const ALLOWED_REPO = {
  owner: 'Iron-Eagle-Security-Ltd',
  repo: 'field-compliance-manager'
};
const MAX_BODY = 256_000;
const MAX_FILE_BYTES = 200_000;
const GITEA_BASE_URL = Deno.env.get('GITEA_BASE_URL');
const GITEA_TOKEN = Deno.env.get('GITEA_TOKEN');
const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SECRET_KEYS_RAW = Deno.env.get('SUPABASE_SECRET_KEYS');
if (!GITEA_BASE_URL) throw new Error('GITEA_BASE_URL is required');
if (!GITEA_TOKEN) throw new Error('GITEA_TOKEN is required');
if (!SUPABASE_URL) throw new Error('SUPABASE_URL is required');
if (!SECRET_KEYS_RAW) throw new Error('SUPABASE_SECRET_KEYS is required');
const SUPABASE_SECRET_KEY = JSON.parse(SECRET_KEYS_RAW).default;
if (!SUPABASE_SECRET_KEY) throw new Error('SUPABASE_SECRET_KEYS.default is required');
const RE_SECRET = /(token|password|passwd|secret|private[_-]?key|authorization|connection[_-]?string|jwt|apikey|api[_-]?key|credential)/i;
function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8'
    }
  });
}
function parseClaims(req) {
  const auth = req.headers.get('authorization') || '';
  if (!auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7);
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    return JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
  } catch  {
    return null;
  }
}
function isBobRole(claims) {
  const appRole = claims?.app_metadata?.role;
  const roles = claims?.app_metadata?.roles;
  return appRole === 'bob' || Array.isArray(roles) && roles.includes('bob');
}
function routeOf(req) {
  const p = new URL(req.url).pathname;
  const parts = p.split('/').filter(Boolean);
  if (parts[0] === FN) return '/' + parts.slice(1).join('/');
  const i = parts.indexOf(FN);
  if (i >= 0) return '/' + parts.slice(i + 1).join('/');
  return p;
}
function assertRepo(owner, repo) {
  return owner === ALLOWED_REPO.owner && repo === ALLOWED_REPO.repo;
}
function isSensitiveTarget(payload) {
  const branch = String(payload?.base || payload?.branch || payload?.new_branch || '').toLowerCase();
  const path = String(payload?.path || '').toLowerCase();
  const content = String(payload?.content || '').toLowerCase();
  return branch === 'main' || branch === 'production' || /schema|migration|infra|secret/.test(path + ' ' + content);
}
function sanitizeText(s) {
  return s.replace(/-----BEGIN[\s\S]*?PRIVATE KEY-----[\s\S]*?-----END[\s\S]*?PRIVATE KEY-----/gi, '[REDACTED_PRIVATE_KEY]').replace(/(authorization\s*:\s*bearer\s+)[^\s]+/gi, '$1[REDACTED]').replace(/(token|password|secret|apikey|api_key|connection_string)\s*[:=]\s*[^\s'"`]+/gi, '$1=[REDACTED]');
}
function redactObject(v) {
  if (v == null) return v;
  if (typeof v === 'string') return sanitizeText(v);
  if (Array.isArray(v)) return v.map(redactObject);
  if (typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v))out[k] = RE_SECRET.test(k) ? '[REDACTED]' : redactObject(val);
    return out;
  }
  return v;
}
async function audit(req, endpoint, target, result, code) {
  const claims = parseClaims(req);
  const row = {
    action: FN,
    entity_type: 'integration',
    entity_id: target,
    change_summary: JSON.stringify({
      endpoint,
      result,
      code,
      actor: claims?.sub ?? null
    })
  };
  await fetch(`${SUPABASE_URL}/rest/v1/audit_log`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_SECRET_KEY,
      'content-type': 'application/json',
      'prefer': 'return=minimal'
    },
    body: JSON.stringify(row)
  }).catch(()=>{});
}
async function gitea(path, init = {}) {
  const res = await fetch(`${GITEA_BASE_URL}${path}`, {
    ...init,
    headers: {
      'authorization': `token ${GITEA_TOKEN}`,
      'content-type': 'application/json',
      ...init.headers || {}
    }
  });
  const txt = await res.text();
  let body = {};
  try {
    body = txt ? JSON.parse(txt) : {};
  } catch  {
    body = {
      raw: txt.slice(0, 10_000)
    };
  }
  return {
    ok: res.ok,
    status: res.status,
    body
  };
}
Deno.serve(async (req)=>{
  if (req.method === 'OPTIONS') return new Response(null, {
    status: 204
  });
  const claims = parseClaims(req);
  if (!claims || !isBobRole(claims)) return json(403, {
    ok: false,
    code: 'FORBIDDEN'
  });
  const route = routeOf(req);
  const method = req.method.toUpperCase();
  if (method === 'GET' && route === '/health') return json(200, {
    ok: true,
    service: FN
  });
  const safeRead = new Set([
    '/repos',
    '/repo',
    '/branches',
    '/file',
    '/commits',
    '/pulls',
    '/issues',
    '/actions/status'
  ]);
  const safeWrite = new Set([
    '/branch',
    '/commit',
    '/pull-request',
    '/issue'
  ]);
  if (!safeRead.has(route) && !safeWrite.has(route)) return json(404, {
    ok: false,
    code: 'NOT_FOUND'
  });
  const url = new URL(req.url);
  let payload = {};
  if (method === 'POST') {
    const len = Number(req.headers.get('content-length') || 0);
    if (len > MAX_BODY) return json(413, {
      ok: false,
      code: 'PAYLOAD_TOO_LARGE'
    });
    payload = await req.json().catch(()=>null);
    if (!payload || typeof payload !== 'object') return json(400, {
      ok: false,
      code: 'INVALID_JSON'
    });
  }
  const owner = String((method === 'GET' ? url.searchParams.get('owner') : payload.owner) || '');
  const repo = String((method === 'GET' ? url.searchParams.get('repo') : payload.repo) || '');
  if (!assertRepo(owner, repo)) return json(403, {
    ok: false,
    code: 'REPO_NOT_ALLOWED'
  });
  try {
    if (method === 'GET') {
      const branch = url.searchParams.get('branch') || 'main';
      if (!/^[a-zA-Z0-9._\/-]{1,120}$/.test(branch)) return json(400, {
        ok: false,
        code: 'INVALID_BRANCH'
      });
      let r;
      if (route === '/repos') r = await gitea(`/api/v1/repos/${owner}/${repo}`);
      else if (route === '/repo') r = await gitea(`/api/v1/repos/${owner}/${repo}`);
      else if (route === '/branches') r = await gitea(`/api/v1/repos/${owner}/${repo}/branches`);
      else if (route === '/commits') r = await gitea(`/api/v1/repos/${owner}/${repo}/commits?sha=${encodeURIComponent(branch)}`);
      else if (route === '/pulls') r = await gitea(`/api/v1/repos/${owner}/${repo}/pulls`);
      else if (route === '/issues') r = await gitea(`/api/v1/repos/${owner}/${repo}/issues`);
      else if (route === '/actions/status') r = await gitea(`/api/v1/repos/${owner}/${repo}/actions/runs`);
      else {
        const path = url.searchParams.get('path') || '';
        if (!path || path.includes('..') || path.startsWith('/')) return json(400, {
          ok: false,
          code: 'INVALID_PATH'
        });
        r = await gitea(`/api/v1/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(branch)}`);
        const size = Number(r.body?.size || 0);
        if (size > MAX_FILE_BYTES) return json(413, {
          ok: false,
          code: 'FILE_TOO_LARGE'
        });
      }
      await audit(req, route, `${owner}/${repo}`, r.ok ? 'ok' : 'error', String(r.status));
      return json(r.status, {
        ok: r.ok,
        data: redactObject(r.body)
      });
    }
    if (method !== 'POST') return json(405, {
      ok: false,
      code: 'METHOD_NOT_ALLOWED'
    });
    if (isSensitiveTarget(payload)) {
      if (!payload.approved || typeof payload.approval_ref !== 'string' || payload.approval_ref.length < 8) {
        return json(412, {
          ok: false,
          code: 'APPROVAL_REQUIRED'
        });
      }
    }
    if (route === '/branch') {
      const new_branch = String(payload.new_branch || '');
      const old_ref = String(payload.from_branch || 'main');
      if (!/^[a-zA-Z0-9._\/-]{1,120}$/.test(new_branch)) return json(400, {
        ok: false,
        code: 'INVALID_BRANCH'
      });
      const r = await gitea(`/api/v1/repos/${owner}/${repo}/branches`, {
        method: 'POST',
        body: JSON.stringify({
          new_branch_name: new_branch,
          old_ref_name: old_ref
        })
      });
      await audit(req, route, `${owner}/${repo}:${new_branch}`, r.ok ? 'ok' : 'error', String(r.status));
      return json(r.status, {
        ok: r.ok,
        data: redactObject(r.body)
      });
    }
    if (route === '/commit') {
      const branch = String(payload.branch || '');
      const path = String(payload.path || '');
      const content = String(payload.content || '');
      if (!/^[a-zA-Z0-9._\/-]{1,120}$/.test(branch)) return json(400, {
        ok: false,
        code: 'INVALID_BRANCH'
      });
      if (!path || path.includes('..') || path.startsWith('/')) return json(400, {
        ok: false,
        code: 'INVALID_PATH'
      });
      if (new TextEncoder().encode(content).length > MAX_FILE_BYTES) return json(413, {
        ok: false,
        code: 'FILE_TOO_LARGE'
      });
      const encoded = btoa(unescape(encodeURIComponent(content)));
      const r = await gitea(`/api/v1/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`, {
        method: 'PUT',
        body: JSON.stringify({
          branch,
          content: encoded,
          message: String(payload.message || 'Bob update')
        })
      });
      await audit(req, route, `${owner}/${repo}:${path}`, r.ok ? 'ok' : 'error', String(r.status));
      return json(r.status, {
        ok: r.ok,
        data: redactObject(r.body)
      });
    }
    if (route === '/pull-request') {
      const base = String(payload.base || '');
      const head = String(payload.head || '');
      if (!base || !head) return json(400, {
        ok: false,
        code: 'MISSING_BRANCH'
      });
      const r = await gitea(`/api/v1/repos/${owner}/${repo}/pulls`, {
        method: 'POST',
        body: JSON.stringify({
          base,
          head,
          title: String(payload.title || 'Bob PR'),
          body: String(payload.body || '')
        })
      });
      await audit(req, route, `${owner}/${repo}:${head}->${base}`, r.ok ? 'ok' : 'error', String(r.status));
      return json(r.status, {
        ok: r.ok,
        data: redactObject(r.body)
      });
    }
    if (route === '/issue') {
      const title = String(payload.title || '').trim();
      if (!title) return json(400, {
        ok: false,
        code: 'MISSING_TITLE'
      });
      const r = await gitea(`/api/v1/repos/${owner}/${repo}/issues`, {
        method: 'POST',
        body: JSON.stringify({
          title,
          body: String(payload.body || '')
        })
      });
      await audit(req, route, `${owner}/${repo}:issue`, r.ok ? 'ok' : 'error', String(r.status));
      return json(r.status, {
        ok: r.ok,
        data: redactObject(r.body)
      });
    }
    return json(404, {
      ok: false,
      code: 'NOT_FOUND'
    });
  } catch  {
    await audit(req, route, `${owner}/${repo}`, 'error', '500');
    return json(500, {
      ok: false,
      code: 'INTERNAL_ERROR'
    });
  }
});
