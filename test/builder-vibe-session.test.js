'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { execFileSync } = require('node:child_process');

const vibe = require('../builder-vibe-session');
const preview = require('../builder-vibe-preview');

const SESSION_ID = '1a2b3c4d-0000-4000-8000-000000000001';
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function sourceRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-src-'));
  git(dir, ['init', '-q', '-b', 'main']);
  fs.mkdirSync(path.join(dir, 'apps/web/src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'apps/web/node_modules'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'apps/web/src/hello.ts'), 'export const hello = "hi";\n');
  fs.writeFileSync(path.join(dir, 'apps/web/node_modules/.gitkeep'), '');
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"x"}\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules\n');
  git(dir, ['add', '-A']);
  git(dir, ['add', '-f', 'apps/web/node_modules/.gitkeep']);
  git(dir, ['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-qm', 'base']);
  return { dir, sha: git(dir, ['rev-parse', 'HEAD']) };
}

function memoryStore(session, ownerMessages = []) {
  const rows = [...ownerMessages];
  const state = { session: { ...session }, rows, completed: {} };
  return {
    state,
    async session() { return { ...state.session }; },
    async updateSession(_id, patch) { Object.assign(state.session, patch); },
    async post(_id, row) { rows.push({ seq: rows.length + 100, ...row }); },
    async complete(id, status) { state.completed[id] = status; },
    async history() { return []; },
    async recentExecution() { return []; },
  };
}

function scriptedModel(steps) {
  const calls = [];
  return {
    calls,
    async callModel({ modelRequest }) {
      calls.push(modelRequest);
      const next = steps.shift();
      if (!next) return { ok: true, data: { content: JSON.stringify({ thought: 'done', tool: 'reply', args: { message: 'Done.' } }) } };
      return { ok: true, data: { content: typeof next === 'string' ? next : JSON.stringify(next), model: 'test-model' } };
    },
  };
}

function setup(steps, extra = {}) {
  const repo = sourceRepo();
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-ws-'));
  const session = { id: SESSION_ID, title: 'Make hello friendlier', status: 'open', base_sha: null, head_sha: null, pr_url: null, pr_number: null };
  const store = memoryStore(session);
  const model = scriptedModel(steps);
  const deps = {
    workspaceRoot,
    gateway: { gatewayUrl: 'http://gateway.invalid', apiToken: 'x' },
    sourceDirFor: () => repo.dir,
    resolveHead: () => repo.sha,
    fetchHealth: async () => null,
    callModel: model.callModel,
    supabase: null,
    ...extra,
  };
  return { repo, workspaceRoot, store, model, deps };
}

const ownerMessage = (content, action = 'message') => ({ id: `m-${Math.random()}`, seq: 10, session_id: SESSION_ID, role: 'owner', content, payload: { action } });

test('vibe branch and workspace names are fixed to the session id', () => {
  assert.equal(vibe.vibeBranchName(SESSION_ID), 'bob/vibe-1a2b3c4d');
  assert.match(vibe.vibeWorkspacePath('/data/ws', SESSION_ID), /\/data\/ws\/vibe\/vibe-1a2b3c4d$/);
  assert.throws(() => vibe.vibeWorkspacePath('/data/ws', '../../etc'));
});

test('an owner message edits the branch, commits the turn and replies', async () => {
  const { store, model, deps, workspaceRoot, repo } = setup([
    { thought: 'look', tool: 'read_file', args: { path: 'apps/web/src/hello.ts' } },
    { thought: 'edit', tool: 'replace_in_file', args: { path: 'apps/web/src/hello.ts', old_text: '"hi"', new_text: '"kia ora"' } },
    { thought: 'tell', tool: 'reply', args: { message: 'Changed the greeting to kia ora.' } },
  ]);
  const outcome = await vibe.processVibeMessage({ store, message: ownerMessage('say kia ora instead'), deps });
  assert.equal(outcome.reply, 'Changed the greeting to kia ora.');
  const ws = vibe.vibeWorkspacePath(workspaceRoot, SESSION_ID);
  assert.equal(git(ws, ['branch', '--show-current']), 'bob/vibe-1a2b3c4d');
  assert.match(fs.readFileSync(path.join(ws, 'apps/web/src/hello.ts'), 'utf8'), /kia ora/);
  assert.equal(git(ws, ['status', '--porcelain']), '');
  assert.match(git(ws, ['log', '-1', '--format=%s']), /^vibe: say kia ora instead/);
  assert.equal(store.state.session.base_sha, repo.sha);
  assert.deepEqual(store.state.session.changed_files, ['apps/web/src/hello.ts']);
  assert.equal(store.state.session.status, 'open');
  const kinds = store.state.rows.map(row => row.kind);
  assert.ok(kinds.includes('tool'));
  assert.ok(kinds.includes('diff'));
  assert.equal(store.state.rows.at(-1).kind, 'message');
  assert.equal(Object.values(store.state.completed)[0], 'done');
  assert.equal(model.calls[0].request.builder_mode, 'vibe_engineer');
  assert.equal(model.calls[0].request.workload_kind, 'vibe_implementation');
  assert.deepEqual(model.calls[0].chain, ['gpu_workstation', 'ollama']);
  assert.equal(model.calls[0].routing_reason, 'private_repository_local_only');
});

test('vibe stops after four identical tool calls rather than spending the full turn budget', async () => {
  const repeated = Array.from({ length: 10 }, () => ({ thought: 'inspect', tool: 'read_file', args: { path: 'apps/web/src/hello.ts' } }));
  const { store, deps, model } = setup(repeated);
  const outcome = await vibe.processVibeMessage({ store, message: ownerMessage('inspect the greeting'), deps, limits: { ...vibe.VIBE_LIMITS, maxTurns: 10 } });
  assert.equal(outcome.error, true);
  assert.match(outcome.reply, /stopped after repeating the same tool call/);
  assert.equal(model.calls.length, 4);
  assert.equal(store.state.rows.filter(row => row.payload?.tool === 'read_file').length, 4);
  assert.equal(store.state.rows.at(-1).kind, 'error');
});

test('protected paths are refused and never committed', async () => {
  const { store, deps, workspaceRoot } = setup([
    { thought: 'bump', tool: 'write_file', args: { path: 'package.json', content: '{"name":"evil"}\n' } },
    { thought: 'tell', tool: 'reply', args: { message: 'Tried.' } },
  ]);
  await vibe.processVibeMessage({ store, message: ownerMessage('change the package name'), deps });
  const ws = vibe.vibeWorkspacePath(workspaceRoot, SESSION_ID);
  assert.equal(fs.readFileSync(path.join(ws, 'package.json'), 'utf8'), '{"name":"x"}\n');
  assert.equal(store.state.rows.find(row => row.payload?.tool === 'write_file').payload.ok, false);
  assert.equal(store.state.rows.some(row => row.kind === 'diff'), false);
});

test('a prose answer is accepted as the reply after one correction', async () => {
  const { store, deps } = setup(['Sure — the greeting lives in hello.ts.', 'It currently says hi.']);
  const outcome = await vibe.processVibeMessage({ store, message: ownerMessage('where is the greeting?'), deps });
  assert.equal(outcome.reply, 'It currently says hi.');
});

test('Vibe image attachments use only a private, installed local vision model', async () => {
  const image = Buffer.from('image-fixture');
  const attachmentId = '2b3c4d5e-0000-4000-8000-000000000002';
  const attachment = {
    id: attachmentId,
    session_id: SESSION_ID,
    uploaded_by: 'owner-uuid',
    file_name: 'error-screen.png',
    file_type: 'image/png',
    file_size_bytes: image.length,
    storage_bucket: 'bob-uploads',
    storage_path: `desktop/owner-uuid/vibe/${SESSION_ID}/${attachmentId}-error-screen.png`,
    extraction_status: 'not_applicable',
  };
  const calls = [];
  let savedPayload;
  const store = {
    async attachments(sessionId, ids) {
      assert.equal(sessionId, SESSION_ID);
      assert.deepEqual(ids, [attachmentId]);
      return [attachment];
    },
    async downloadAttachment(row) {
      assert.equal(row.id, attachmentId);
      return image;
    },
    async updateOwnerPayload(_id, payload) { savedPayload = payload; },
  };
  const context = await vibe.prepareVibeAttachmentContext({
    store,
    session: { id: SESSION_ID, created_by: 'owner-uuid' },
    message: { id: 'owner-message', payload: { attachment_ids: [attachmentId] } },
    supabase: null,
    deps: {
      visionUrl: 'http://127.0.0.1:11434',
      downloadAttachment: async () => image,
      visionFetch: async (url, options = {}) => {
        calls.push({ url, options });
        if (url.endsWith('/api/tags')) return { ok: true, json: async () => ({ models: [{ name: 'moondream:latest' }] }) };
        return { ok: true, json: async () => ({ response: 'A staff form is open with a red validation alert at the top.' }) };
      },
    },
  });
  assert.match(context[0].context, /Local visual analysis \(advisory\)/);
  assert.match(context[0].context, /red validation alert/);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, 'http://127.0.0.1:11434/api/generate');
  assert.deepEqual(JSON.parse(calls[1].options.body).images, [image.toString('base64')]);
  assert.match(savedPayload.attachment_context[0].context, /red validation alert/);
});

test('Vibe rejects public vision endpoints and attachment IDs from other sessions', async () => {
  await assert.rejects(
    vibe.assertLocalVisionUrl('https://ollama.example.com', async () => [{ address: '203.0.113.4' }]),
    /restricted to private local vision endpoints/,
  );
  await assert.rejects(vibe.assertLocalVisionUrl('http://169.254.169.254'));
  const attachmentId = '2b3c4d5e-0000-4000-8000-000000000002';
  await assert.rejects(vibe.prepareVibeAttachmentContext({
    store: { attachments: async () => [] },
    session: { id: SESSION_ID },
    message: { id: 'owner-message', payload: { attachment_ids: [attachmentId] } },
    supabase: null,
  }), /not registered to this Vibe session/);
});

test('revert undoes the last turn and ship pushes the branch and opens one pull request', async () => {
  process.env.BOB_BUILDER_GIT_EMAIL = '256263525+DonSquires@users.noreply.github.com';
  process.env.BOB_BUILDER_GIT_NAME = 'Don Squires';
  try {
    const published = [];
    const opened = [];
    const { store, deps, workspaceRoot, repo } = setup([
      { thought: 'edit', tool: 'replace_in_file', args: { path: 'apps/web/src/hello.ts', old_text: '"hi"', new_text: '"one"' } },
      { thought: 'tell', tool: 'reply', args: { message: 'one' } },
      { thought: 'edit', tool: 'replace_in_file', args: { path: 'apps/web/src/hello.ts', old_text: '"one"', new_text: '"two"' } },
      { thought: 'tell', tool: 'reply', args: { message: 'two' } },
    ], {
      publish: async args => { published.push(args); },
      openPullRequest: async args => { opened.push(args); return { url: 'https://github.com/o/r/pull/7', number: 7 }; },
    });
    await vibe.processVibeMessage({ store, message: ownerMessage('one'), deps });
    await vibe.processVibeMessage({ store, message: ownerMessage('two'), deps });
    const ws = vibe.vibeWorkspacePath(workspaceRoot, SESSION_ID);
    const undo = await vibe.processVibeMessage({ store, message: ownerMessage('revert', 'revert'), deps });
    assert.match(undo.reply, /Undid the last change/);
    assert.match(fs.readFileSync(path.join(ws, 'apps/web/src/hello.ts'), 'utf8'), /"one"/);
    const shipped = await vibe.processVibeMessage({ store, message: ownerMessage('ship', 'ship'), deps });
    assert.match(shipped.reply, /pull\/7/);
    assert.equal(published.length, 1);
    assert.equal(published[0].branch, 'bob/vibe-1a2b3c4d');
    assert.equal(opened.length, 1);
    assert.match(opened[0].body, /never merge or deploy/);
    assert.equal(store.state.session.status, 'shipped');
    assert.equal(store.state.session.pr_url, 'https://github.com/o/r/pull/7');
    assert.equal(git(ws, ['log', '-1', '--format=%ae']), '256263525+DonSquires@users.noreply.github.com');
    assert.notEqual(git(ws, ['rev-parse', 'HEAD']), repo.sha);
  } finally {
    delete process.env.BOB_BUILDER_GIT_EMAIL;
    delete process.env.BOB_BUILDER_GIT_NAME;
  }
});

test('ship with no changes does not publish', async () => {
  let published = 0;
  const { store, deps } = setup([], { publish: async () => { published++; } });
  const outcome = await vibe.processVibeMessage({ store, message: ownerMessage('ship', 'ship'), deps });
  assert.match(outcome.reply, /nothing to ship/);
  assert.equal(published, 0);
});

test('a closed session is skipped', async () => {
  const { store, deps } = setup([]);
  store.state.session.status = 'closed';
  const message = ownerMessage('hello');
  assert.deepEqual(await vibe.processVibeMessage({ store, message, deps }), { skipped: true });
  assert.equal(store.state.completed[message.id], 'failed');
});

test('preview cookies are bound to one session and expire', () => {
  const secret = Buffer.from('s3cret');
  const now = Date.now();
  const header = preview.cookieHeader(secret, SESSION_ID, now);
  assert.match(header, /Path=\/vibe\/1a2b3c4d-0000-4000-8000-000000000001\/; .*HttpOnly; Secure; SameSite=None; Partitioned/);
  const cookie = header.split(';')[0];
  assert.equal(preview.verifyCookie(secret, `a=b; ${cookie}`, SESSION_ID, now), true);
  assert.equal(preview.verifyCookie(secret, cookie, '1a2b3c4d-0000-4000-8000-000000000002', now), false);
  assert.equal(preview.verifyCookie(Buffer.from('other'), cookie, SESSION_ID, now), false);
  assert.equal(preview.verifyCookie(secret, cookie, SESSION_ID, now + 9 * 3600_000), false);
  assert.equal(preview.verifyCookie(secret, cookie.replace(/.$/, c => (c === 'A' ? 'B' : 'A')), SESSION_ID, now), false);
  assert.deepEqual(preview.parseVibePath(`/vibe/${SESSION_ID}/src/main.tsx`), { sessionId: SESSION_ID, rest: '/src/main.tsx' });
  assert.equal(preview.parseVibePath('/vibe/not-a-session/'), null);
});

test('the preview proxy refuses without a cookie and unlocks from a valid ticket only', async () => {
  const manager = preview.createVibePreviewManager({ workspaceRoot: os.tmpdir(), secret: Buffer.from('k'), onStatus: async () => {} });
  const goodTicket = 'a'.repeat(64);
  const server = http.createServer(async (req, res) => {
    if (!(await manager.handleHttp(req, res, { redeemTicket: async (_id, ticket) => (ticket === goodTicket ? 'owner-uuid' : null) }))) { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const get = (urlPath, headers = {}) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: urlPath, headers }, res => { res.resume(); res.on('end', () => resolve(res)); }).on('error', reject);
  });
  try {
    assert.equal((await get(`/vibe/${SESSION_ID}/`)).statusCode, 401);
    assert.equal((await get(`/vibe/${SESSION_ID}/__open?ticket=${'b'.repeat(64)}`)).statusCode, 403);
    const opened = await get(`/vibe/${SESSION_ID}/__open?ticket=${goodTicket}`);
    assert.equal(opened.statusCode, 302);
    assert.equal(opened.headers.location, `/vibe/${SESSION_ID}/`);
    assert.match(opened.headers['content-security-policy'], /frame-ancestors/);
    const cookie = opened.headers['set-cookie'][0].split(';')[0];
    const notRunning = await get(`/vibe/${SESSION_ID}/`, { cookie });
    assert.equal(notRunning.statusCode, 503);
    assert.equal((await get('/other')).statusCode, 404);
  } finally {
    server.close();
  }
});

test('the vite wrapper config serves the app under the session base path', () => {
  const config = preview.viteWrapperConfig({ sessionId: SESSION_ID });
  assert.match(config, /import config from '\.\.\/\.\.\/vite\.config\.ts'/);
  assert.match(config, new RegExp(`base = '/vibe/${SESSION_ID}/'`));
  assert.match(config, /allowedHosts: true/);
});

test('preview dependency install always includes devDependencies', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-preview-'));
  const workspacePath = path.join(root, 'vibe', 'vibe-12345678');
  const web = path.join(workspacePath, 'apps', 'web');
  fs.mkdirSync(web, { recursive: true });
  fs.writeFileSync(path.join(web, 'package.json'), '{"name":"web"}\n');
  fs.writeFileSync(path.join(web, 'package-lock.json'), '{"name":"web","lockfileVersion":3}\n');
  const cacheHash = crypto.createHash('sha256').update(fs.readFileSync(path.join(web, 'package-lock.json'))).update(fs.readFileSync(path.join(web, 'package.json'))).digest('hex').slice(0, 16);
  const staleCache = path.join(root, 'vibe-cache', cacheHash);
  fs.mkdirSync(path.join(staleCache, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(staleCache, '.complete'), 'stale cache entry without Vite');
  const calls = [];
  const spawnImpl = (cmd, args, options) => {
    calls.push({ cmd, args, options });
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    process.nextTick(() => {
      if (cmd === 'npm') {
        fs.mkdirSync(path.join(options.cwd, 'node_modules', 'vite'), { recursive: true });
        fs.writeFileSync(path.join(options.cwd, 'node_modules', 'vite', 'package.json'), '{"name":"vite"}\n');
        child.emit('close', 0);
        return;
      }
      child.emit('error', new Error(`unexpected command: ${cmd}`));
    });
    return child;
  };
  const manager = preview.createVibePreviewManager({ workspaceRoot: root, secret: Buffer.from('k'), onStatus: async () => {}, spawnImpl });
  await manager.ensureWebDependencies(workspacePath);
  const install = calls.find(call => call.cmd === 'npm');
  assert.ok(install, 'npm ci was called');
  assert.ok(install.args.includes('--include=dev'));
  assert.equal(install.options.env.NODE_ENV, 'development');
  assert.equal(install.options.env.NPM_CONFIG_PRODUCTION, 'false');
  assert.equal(install.options.env.npm_config_production, 'false');
  assert.equal(fs.existsSync(path.join(web, 'node_modules', 'vite', 'package.json')), true);
});
