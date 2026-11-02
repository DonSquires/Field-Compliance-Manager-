'use strict';

// Live previews for vibe sessions: one Vite dev server per session worktree, served to the
// owner through the control plane at /vibe/<session-id>/ (HTTP and the HMR WebSocket).
// Access starts from a one-time ticket the owner's browser obtains through the governed
// builder_vibe_preview_ticket RPC; redeeming it sets an HMAC cookie scoped to that path.
// The preview runs the session's code against the same Supabase project as production,
// exactly like a Vercel preview build: the owner signs in inside it with their own account.

const fs = require('node:fs');
const net = require('node:net');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');

const SESSION_PATH = /^\/vibe\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\/.*)?$/;
const COOKIE_NAME = 'bob_vibe';
const COOKIE_TTL_MS = 8 * 60 * 60_000;
const DEFAULT_FRAME_ANCESTORS = "'self' https://field-compliance-manager.vercel.app https://*.vercel.app https://*.fcmanager.co.nz https://fcmanager.co.nz";

function parseVibePath(pathname) {
  const match = SESSION_PATH.exec(String(pathname || ''));
  return match ? { sessionId: match[1], rest: match[2] || '/' } : null;
}

function signCookie(secret, sessionId, expiresAt) {
  const payload = `${sessionId}.${expiresAt}`;
  return `${payload}.${crypto.createHmac('sha256', secret).update(payload).digest('base64url')}`;
}

function verifyCookie(secret, header, sessionId, now = Date.now()) {
  const cookies = String(header || '').split(';').map(part => part.trim());
  for (const cookie of cookies) {
    if (!cookie.startsWith(`${COOKIE_NAME}=`)) continue;
    const [id, expires, signature] = cookie.slice(COOKIE_NAME.length + 1).split('.');
    if (id !== sessionId || !/^\d+$/.test(expires || '') || Number(expires) < now) continue;
    const expected = signCookie(secret, id, expires).split('.')[2];
    if (signature && expected.length === signature.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) return true;
  }
  return false;
}

function cookieHeader(secret, sessionId, now = Date.now()) {
  const expiresAt = now + COOKIE_TTL_MS;
  // SameSite=None + Partitioned lets the preview iframe inside the app keep its cookie; Path scopes it to one session.
  return `${COOKIE_NAME}=${signCookie(secret, sessionId, expiresAt)}; Path=/vibe/${sessionId}/; Max-Age=${Math.floor(COOKIE_TTL_MS / 1000)}; HttpOnly; Secure; SameSite=None; Partitioned`;
}

function lockHash(webDir) {
  const lock = fs.readFileSync(path.join(webDir, 'package-lock.json'));
  return crypto.createHash('sha256').update(lock).update(fs.readFileSync(path.join(webDir, 'package.json'))).digest('hex').slice(0, 16);
}

function viteWrapperConfig({ sessionId }) {
  // Lives in node_modules/.vibe (git-ignored) so it never shows up as a session change.
  return [
    "import config from '../../vite.config.ts';",
    `const base = '/vibe/${sessionId}/';`,
    'const { test: _test, ...app } = config;',
    'export default { ...app, base, clearScreen: false, server: { ...(app.server || {}), host: "127.0.0.1", strictPort: true, allowedHosts: true, hmr: { path: "__vibe_hmr" } } };',
    '',
  ].join('\n');
}

function createVibePreviewManager({ workspaceRoot, supabaseUrl, anonKey, secret, maxConcurrent = 2, idleMs = 20 * 60_000, basePort = 5310, log = console, spawnImpl = spawn, onStatus = async () => {} }) {
  if (!secret) throw new Error('vibe preview secret is required');
  const previews = new Map();
  const cacheRoot = path.join(path.resolve(workspaceRoot), 'vibe-cache');
  const installs = new Map();
  const starting = new Set();

  // node_modules for apps/web comes from a cache keyed by the lockfile (package manifests are protected
  // paths, so a session can never change them) and is hard-linked into each worktree in seconds.
  async function ensureWebDependencies(workspacePath) {
    const webDir = path.join(workspacePath, 'apps', 'web');
    const target = path.join(webDir, 'node_modules');
    if (fs.existsSync(path.join(target, 'vite', 'package.json'))) return target;
    const hash = lockHash(webDir);
    const cacheDir = path.join(cacheRoot, hash);
    const cached = path.join(cacheDir, 'node_modules');
    if (!fs.existsSync(path.join(cacheDir, '.complete')) || !fs.existsSync(path.join(cached, 'vite', 'package.json'))) {
      if (!installs.has(hash)) {
        installs.set(hash, new Promise((resolve, reject) => {
          fs.rmSync(cacheDir, { recursive: true, force: true });
          fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
          fs.copyFileSync(path.join(webDir, 'package.json'), path.join(cacheDir, 'package.json'));
          fs.copyFileSync(path.join(webDir, 'package-lock.json'), path.join(cacheDir, 'package-lock.json'));
          const child = spawnImpl('npm', ['ci', '--include=dev', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: cacheDir, env: safeEnv(), stdio: ['ignore', 'ignore', 'pipe'] });
          let stderr = '';
          child.stderr?.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
          child.on('error', reject);
          child.on('close', code => {
            if (code === 0) { fs.writeFileSync(path.join(cacheDir, '.complete'), new Date().toISOString()); resolve(); }
            else reject(new Error(`npm ci failed (${code}): ${stderr.trim().slice(-400)}`));
          });
        }).finally(() => installs.delete(hash)));
      }
      await installs.get(hash);
    }
    fs.rmSync(target, { recursive: true, force: true });
    execFileSync('cp', ['-al', cached, target]);
    // apps/web/node_modules/.gitkeep is tracked; replacing the directory must not show up as a deletion.
    try { execFileSync('git', ['checkout', '--', 'apps/web/node_modules/.gitkeep'], { cwd: workspacePath, stdio: 'ignore' }); } catch { /* not tracked at this commit */ }
    return target;
  }

  function safeEnv() {
    const { BOB_ADMIN_TOKEN: _a, BOB_RUNNER_TOKEN: _r, BOB_MODEL_GATEWAY_TOKEN: _g, SUPABASE_SERVICE_ROLE_KEY: _s, OPENAI_API_KEY: _o, OLLAMA_API_TOKEN: _ol, GITEA_TOKEN: _gt, GITHUB_TOKEN: _gh, BOB_GITHUB_ACCESS_TOKEN: _bg, VERCEL_TOKEN: _v, GRANDMASTER_TEST_PASSWORD: _p, BOB_LAPTOP_SSH_KEY: _l, NODE_OPTIONS: _n, PORT: _port, ...rest } = process.env;
    return { ...rest, CI: '1', FORCE_COLOR: '0', NODE_ENV: 'development', NPM_CONFIG_PRODUCTION: 'false', npm_config_production: 'false' };
  }

  function freePort() {
    const used = new Set([...previews.values()].map(entry => entry.port));
    for (let port = basePort; port < basePort + 50; port++) if (!used.has(port)) return port;
    throw new Error('no preview port available');
  }

  async function stop(sessionId, reason = 'stopped') {
    const entry = previews.get(sessionId);
    if (!entry) return false;
    previews.delete(sessionId);
    try { entry.child.kill('SIGTERM'); } catch { /* gone */ }
    setTimeout(() => { try { entry.child.kill('SIGKILL'); } catch { /* gone */ } }, 5000).unref?.();
    await onStatus(sessionId, { preview_status: 'off', preview_detail: reason, ...(reason === 'idle' ? { preview_requested: false } : {}) }).catch(() => {});
    return true;
  }

  async function start(sessionId, workspacePath) {
    const existing = previews.get(sessionId);
    if (existing) { existing.lastUsed = Date.now(); return existing; }
    while (previews.size >= maxConcurrent) {
      const oldest = [...previews.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
      await stop(oldest[0], 'replaced by a newer preview');
    }
    await onStatus(sessionId, { preview_status: 'starting', preview_detail: 'Installing dependencies and starting the dev server' });
    await ensureWebDependencies(workspacePath);
    const webDir = path.join(workspacePath, 'apps', 'web');
    const wrapperDir = path.join(webDir, 'node_modules', '.vibe');
    fs.mkdirSync(wrapperDir, { recursive: true });
    const wrapper = path.join(wrapperDir, 'vite.config.mjs');
    fs.writeFileSync(wrapper, viteWrapperConfig({ sessionId }));
    const port = freePort();
    const child = spawnImpl(process.execPath, [path.join('node_modules', 'vite', 'bin', 'vite.js'), '--config', wrapper, '--port', String(port)], {
      cwd: webDir,
      env: { ...safeEnv(), VITE_SUPABASE_URL: supabaseUrl || '', VITE_SUPABASE_ANON_KEY: anonKey || '', BROWSER: 'none' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const entry = { sessionId, port, child, workspacePath, lastUsed: Date.now(), output: '', ready: false };
    previews.set(sessionId, entry);
    const capture = chunk => { entry.output = (entry.output + chunk).slice(-4000); };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);
    child.on('exit', code => {
      if (previews.get(sessionId) !== entry) return;
      previews.delete(sessionId);
      onStatus(sessionId, { preview_status: 'failed', preview_detail: `dev server exited (${code}): ${entry.output.trim().slice(-300)}` }).catch(() => {});
    });
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline && previews.get(sessionId) === entry) {
      if (await probe(port, sessionId)) {
        entry.ready = true;
        await onStatus(sessionId, { preview_status: 'ready', preview_detail: null });
        return entry;
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    if (previews.get(sessionId) === entry) {
      await stop(sessionId, 'dev server did not become ready in 90 s');
      await onStatus(sessionId, { preview_status: 'failed', preview_detail: `dev server did not become ready: ${entry.output.trim().slice(-300)}` });
    }
    return null;
  }

  function probe(port, sessionId) {
    return new Promise(resolve => {
      const req = http.get({ host: '127.0.0.1', port, path: `/vibe/${sessionId}/`, timeout: 2000 }, res => { res.resume(); resolve(res.statusCode < 500); });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
  }

  async function reap(now = Date.now()) {
    for (const [sessionId, entry] of previews) if (now - entry.lastUsed > idleMs) await stop(sessionId, 'idle');
  }

  // Desired state lives in builder_vibe_sessions.preview_requested; this converges the running set to it.
  async function reconcile(supabase, workspacePathFor) {
    const { data, error } = await supabase.from('builder_vibe_sessions').select('id, status, preview_requested, preview_status').or('preview_requested.eq.true,preview_status.neq.off');
    if (error) throw new Error(error.message);
    for (const session of data || []) {
      const wanted = session.preview_requested && session.status !== 'closed';
      if (!wanted && previews.has(session.id)) await stop(session.id, 'turned off');
      else if (!wanted && session.preview_status !== 'off') await onStatus(session.id, { preview_status: 'off', preview_detail: null });
      else if (wanted && !previews.has(session.id)) {
        const workspacePath = workspacePathFor(session.id);
        if (!fs.existsSync(path.join(workspacePath, 'apps', 'web', 'package.json'))) {
          if (session.preview_status !== 'failed') await onStatus(session.id, { preview_status: 'failed', preview_detail: 'Send Bob a first message so the session branch exists, then turn the preview on.' });
          continue;
        }
        if (session.preview_status === 'failed' || starting.has(session.id)) continue;
        starting.add(session.id);
        start(session.id, workspacePath)
          .catch(error => onStatus(session.id, { preview_status: 'failed', preview_detail: String(error.message).slice(0, 400) }).catch(() => {}))
          .finally(() => starting.delete(session.id));
      }
    }
    await reap();
  }

  function framingHeaders(headers) {
    const out = { ...headers };
    delete out['x-frame-options'];
    delete out['content-security-policy'];
    out['content-security-policy'] = `frame-ancestors ${process.env.BOB_VIBE_FRAME_ANCESTORS || DEFAULT_FRAME_ANCESTORS}`;
    out['cache-control'] = out['cache-control'] || 'no-store';
    return out;
  }

  function sendPage(res, status, title, detail) {
    res.writeHead(status, framingHeaders({ 'content-type': 'text/html; charset=utf-8' }));
    res.end(`<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:15px system-ui;padding:2rem;color:#334"><h1 style="font-size:1.1rem">${title}</h1><p>${detail}</p></body>`);
  }

  // Returns true when the request belonged to a vibe preview (handled), false otherwise.
  async function handleHttp(req, res, { redeemTicket }) {
    const url = new URL(req.url, 'http://local');
    const target = parseVibePath(url.pathname);
    if (!target) return false;
    const { sessionId, rest } = target;
    if (rest === '/__open') {
      const ticket = url.searchParams.get('ticket') || '';
      const owner = /^[0-9a-f]{64}$/.test(ticket) ? await redeemTicket(sessionId, ticket).catch(() => null) : null;
      if (!owner) { sendPage(res, 403, 'Preview link expired', 'Open the preview again from the vibe session.'); return true; }
      res.writeHead(302, framingHeaders({ location: `/vibe/${sessionId}/`, 'set-cookie': cookieHeader(secret, sessionId) }));
      res.end();
      return true;
    }
    if (!verifyCookie(secret, req.headers.cookie, sessionId)) { sendPage(res, 401, 'Preview locked', 'Open the preview from the vibe session to unlock it.'); return true; }
    const entry = previews.get(sessionId);
    if (!entry || !entry.ready) { sendPage(res, 503, 'Preview is not running', 'Turn the live preview on in the vibe session; it starts in under a minute.'); return true; }
    entry.lastUsed = Date.now();
    const headers = { ...req.headers, host: `127.0.0.1:${entry.port}` };
    delete headers.cookie;
    const upstream = http.request({ host: '127.0.0.1', port: entry.port, method: req.method, path: req.url, headers }, upstreamRes => {
      res.writeHead(upstreamRes.statusCode || 502, framingHeaders(upstreamRes.headers));
      upstreamRes.pipe(res);
    });
    upstream.on('error', () => { if (!res.headersSent) sendPage(res, 502, 'Preview unavailable', 'The dev server did not answer.'); else res.end(); });
    req.pipe(upstream);
    return true;
  }

  function handleUpgrade(req, socket, head) {
    const url = new URL(req.url, 'http://local');
    const target = parseVibePath(url.pathname);
    if (!target) return false;
    const entry = previews.get(target.sessionId);
    if (!entry || !verifyCookie(secret, req.headers.cookie, target.sessionId)) { socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return true; }
    entry.lastUsed = Date.now();
    const upstream = net.connect(entry.port, '127.0.0.1', () => {
      const headers = { ...req.headers, host: `127.0.0.1:${entry.port}` };
      delete headers.cookie;
      const lines = [`${req.method} ${req.url} HTTP/1.1`, ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`), '', ''];
      upstream.write(lines.join('\r\n'));
      if (head?.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    const close = () => { upstream.destroy(); socket.destroy(); };
    upstream.on('error', close);
    socket.on('error', close);
    return true;
  }

  return { start, stop, reap, reconcile, ensureWebDependencies, handleHttp, handleUpgrade, running: () => [...previews.keys()] };
}

module.exports = { COOKIE_NAME, parseVibePath, signCookie, verifyCookie, cookieHeader, viteWrapperConfig, createVibePreviewManager };
