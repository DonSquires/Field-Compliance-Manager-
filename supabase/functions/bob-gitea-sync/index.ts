function pickEnv(...names) {
  for (const n of names){
    const v = Deno.env.get(n);
    if (v && v.trim().length > 0) return v;
  }
  return undefined;
}
const SHARED_SECRET = pickEnv('BOB_SYNC_SHARED_SECRET', 'bob_sync_shared_secret');
const GITEA_BASE_URL = pickEnv('GITEA_BASE_URL', 'API_URL');
const GITEA_TOKEN = pickEnv('GITEA_TOKEN', 'API_TOKEN');
const GITEA_REPO_OWNER = pickEnv('GITEA_REPO_OWNER', 'GITEA_OWNER');
const GITEA_REPO_NAME = pickEnv('GITEA_REPO_NAME', 'GITEA_REPO');
function json(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json'
    }
  });
}
function withTimeout(ms) {
  return AbortSignal.timeout(ms);
}
async function fetchDiag(url, init, timeoutMs) {
  const startedAt = Date.now();
  try {
    const res = await fetch(url, {
      ...init,
      signal: withTimeout(timeoutMs)
    });
    const text = await res.text();
    return {
      ok: res.ok,
      status: res.status,
      elapsedMs: Date.now() - startedAt,
      bodyPreview: text.slice(0, 500),
      error: null
    };
  } catch (e) {
    return {
      ok: false,
      status: null,
      elapsedMs: Date.now() - startedAt,
      bodyPreview: '',
      error: e instanceof Error ? `${e.name}: ${e.message}` : String(e)
    };
  }
}
Deno.serve(async (req)=>{
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();
  if (req.method !== 'POST') {
    return json(405, {
      requestId,
      ok: false,
      code: 'METHOD_NOT_ALLOWED',
      message: 'Use POST'
    });
  }
  const inboundSecret = req.headers.get('x-bob-sync-secret');
  if (!SHARED_SECRET) {
    return json(500, {
      requestId,
      ok: false,
      code: 'MISSING_ENV',
      message: 'Missing shared secret env var',
      acceptedNames: [
        'BOB_SYNC_SHARED_SECRET',
        'bob_sync_shared_secret'
      ]
    });
  }
  if (inboundSecret !== SHARED_SECRET) {
    return json(401, {
      requestId,
      ok: false,
      code: 'UNAUTHORIZED_BAD_SECRET',
      message: 'Invalid x-bob-sync-secret'
    });
  }
  const missing = [
    [
      'GITEA_BASE_URL|API_URL',
      GITEA_BASE_URL
    ],
    [
      'GITEA_TOKEN|API_TOKEN',
      GITEA_TOKEN
    ],
    [
      'GITEA_REPO_OWNER|GITEA_OWNER',
      GITEA_REPO_OWNER
    ],
    [
      'GITEA_REPO_NAME|GITEA_REPO',
      GITEA_REPO_NAME
    ]
  ].filter(([, v])=>!v).map(([k])=>k);
  if (missing.length) {
    return json(500, {
      requestId,
      ok: false,
      code: 'MISSING_ENV',
      message: 'Missing required environment variables',
      missing
    });
  }
  const baseUrl = GITEA_BASE_URL.replace(/\/$/, '');
  const repoPath = `${GITEA_REPO_OWNER}/${GITEA_REPO_NAME}`;
  const headers = {
    'Authorization': `token ${GITEA_TOKEN}`,
    'Accept': 'application/json'
  };
  const versionCheck = await fetchDiag(`${baseUrl}/api/v1/version`, {
    method: 'GET',
    headers
  }, 10000);
  if (!versionCheck.ok) {
    return json(502, {
      requestId,
      ok: false,
      code: 'GITEA_UNREACHABLE_OR_UNAUTHORIZED',
      message: 'Failed Gitea version probe',
      probe: {
        url: `${baseUrl}/api/v1/version`,
        ...versionCheck
      }
    });
  }
  const repoUrl = `${baseUrl}/api/v1/repos/${encodeURIComponent(GITEA_REPO_OWNER)}/${encodeURIComponent(GITEA_REPO_NAME)}`;
  const repoCheck = await fetchDiag(repoUrl, {
    method: 'GET',
    headers
  }, 15000);
  if (!repoCheck.ok) {
    return json(502, {
      requestId,
      ok: false,
      code: 'REPO_ACCESS_FAILED',
      message: 'Failed repository probe',
      repo: repoPath,
      probe: {
        url: repoUrl,
        ...repoCheck
      }
    });
  }
  return json(200, {
    requestId,
    ok: true,
    code: 'DIAGNOSTIC_OK',
    message: 'Connectivity and repo access checks passed. Ready to run sync logic.',
    repo: repoPath,
    elapsedMs: Date.now() - startedAt
  });
});
