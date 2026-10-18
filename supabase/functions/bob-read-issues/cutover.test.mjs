import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const rootId = 'a7c916f5-b980-47f7-ac47-9989b8f19e21';
const childId = 'f6df4b84-03f1-4ad2-adfb-7d7fd9d32704';
const orgId = '11111111-1111-4111-8111-111111111111';
const projectId = '22222222-2222-4222-8222-222222222222';
const userId = '33333333-3333-4333-8333-333333333333';
const sha = '6f570b760ff3bae5140d3a22ba22c4fd4544d67d';
const branch = 'bob/job-a7c916f5b98047f7ac47';
const base = { organization_id: orgId, project_id: projectId, title: 'Synthetic Builder test', description: '', task_description: 'Synthetic brief', task_run_id: null, target_sha: sha };

test('Builder cutover handlers preserve HTTP contracts without a production database', async t => {
  let role = 'grand_master', dbFailure = false, cpFailure = false, runnerFailure = false;
  let jobs = [
    { ...base, id: rootId, parent_job_id: null, branch_name: 'main', workspace_branch: branch, status: 'failed', created_at: '2026-10-16T00:00:00Z' },
    { ...base, id: childId, parent_job_id: rootId, branch_name: branch, workspace_branch: branch, status: 'implementation_pending', created_at: '2026-10-17T00:00:00Z' },
  ];
  const notes = [], calls = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const raw = await Array.fromAsync(req).then(parts => Buffer.concat(parts).toString());
    const body = raw ? JSON.parse(raw) : null;
    calls.push({ path: url.pathname, query: url.searchParams, method: req.method, body });
    const send = (body, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body));
    };
    if (url.pathname === '/auth/v1/user') return send({ id: userId, email: 'synthetic-builder@example.invalid' });
    if (url.pathname === '/api/bob/builder/repository/head') return send(cpFailure ? { error: 'unavailable' } : { sha, ref: 'main' }, cpFailure ? 503 : 200);
    if (url.pathname === '/api/bob/builder/repository/search') return send({ results: [{ path: 'example.ts', startline: 1, data: 'synthetic source' }] });
    if (url.pathname === '/api/bob/builder/repository/file') return send({ content: 'synthetic source\nsecond line' });
    if (url.pathname === '/api/bob/builder/repository/tree') return send({ entries: [{ path: 'example.ts' }] });
    if (url.pathname === '/api/bob/builder/jobs') {
      const created = { ...base, id: '44444444-4444-4444-8444-444444444444', target_sha: sha, status: 'intake',
        title: body.title, task_description: body.taskDescription, description: body.description,
        requested_action: body.requestedAction, target_environment: body.targetEnvironment, code_review_mode: body.codeReviewMode,
        created_at: '2026-10-18T01:00:00Z' };
      jobs.push(created); return send(created, 201);
    }
    if (/\/api\/bob\/builder\/jobs\/[^/]+\/run$/.test(url.pathname)) return send(
      runnerFailure ? { error: 'runner unavailable' } : { accepted: true, job_id: url.pathname.split('/')[5] }, runnerFailure ? 503 : 202,
    );
    if (url.pathname === '/rest/v1/rpc/builder_autopilot_bind') return send({ id: body._job_id });
    const table = url.pathname.replace('/rest/v1/', '');
    if (dbFailure && table !== 'user_profiles') return send({ message: 'Synthetic database failure' }, 503);
    let rows;
    if (table === 'user_profiles') rows = [{ id: userId, role }];
    else if (table === 'builder_projects') rows = [{ id: projectId, organization_id: orgId, gitea_owner: 'DonSquires', gitea_repo: 'Field-Compliance-Manager-', status: 'active' }];
    else if (table === 'builder_jobs') rows = jobs;
    else if (table === 'builder_job_steps') rows = [];
    else if (table === 'bob_self_memory') {
      if (req.method === 'POST') {
        const note = { ...body, id: '55555555-5555-4555-8555-555555555555', created_at: new Date().toISOString() };
        notes.push(note); return send(note, 201);
      }
      rows = notes;
    } else return send({ message: `Unexpected fixture request ${url.pathname}` }, 500);
    rows = [...rows];
    for (const [field, expression] of url.searchParams) {
      if (expression.startsWith('eq.')) rows = rows.filter(row => String(row[field]) === expression.slice(3));
      else if (expression.startsWith('in.(')) rows = rows.filter(row => expression.slice(4, -1).split(',').includes(row[field]));
      else if (expression.startsWith('not.in.(')) rows = rows.filter(row => !expression.slice(8, -1).split(',').includes(row[field]));
      else if (expression.startsWith('gte.')) rows = rows.filter(row => String(row[field]) >= expression.slice(4));
      else if (expression.startsWith('lte.')) rows = rows.filter(row => String(row[field]) <= expression.slice(4));
      else if (expression.startsWith('ilike.')) rows = rows.filter(row => String(row[field]).toLowerCase().includes(expression.slice(6).replaceAll('%', '').toLowerCase()));
    }
    const order = url.searchParams.get('order');
    if (order?.startsWith('created_at.desc')) rows.sort((a, b) => b.created_at.localeCompare(a.created_at));
    const limit = url.searchParams.get('limit'); if (limit) rows = rows.slice(0, Number(limit));
    const single = String(req.headers.accept).includes('application/vnd.pgrst.object+json');
    send(single ? rows[0] ?? null : rows);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const api = `http://127.0.0.1:${server.address().port}`;
  const start = async slug => {
    const entry = fileURLToPath(new URL(`../${slug}/index.ts`, import.meta.url));
    // Only local network I/O is allowed. Any provider fallback fails this test.
    const process = spawn('deno', ['run', '--no-config', '--allow-env', '--allow-net=127.0.0.1,0.0.0.0:8000', entry], {
      env: { PATH: globalThis.process.env.PATH, HOME: globalThis.process.env.HOME, DENO_DIR: globalThis.process.env.DENO_DIR ?? `${globalThis.process.env.HOME}/.cache/deno`,
        SUPABASE_URL: api, SUPABASE_ANON_KEY: 'synthetic-anon-key', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service-key',
        BOB_CONTROL_PLANE_URL: api, BOB_ADMIN_TOKEN: 'synthetic-control-token' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { process.kill(); reject(new Error(`Runtime startup timed out: ${output}`)); }, 60000);
      const read = chunk => {
        output += chunk.toString();
        if (output.includes('Listening on')) { clearTimeout(timeout); resolve(); }
      };
      process.stdout.on('data', read); process.stderr.on('data', read);
      process.once('exit', code => { clearTimeout(timeout); reject(new Error(`Runtime exited ${code}: ${output}`)); });
    });
    return async () => { process.kill(); await once(process, 'exit'); };
  };
  const invoke = async (body, { auth = true, method = 'POST' } = {}) => {
    const result = await fetch('http://127.0.0.1:8000', {
      method, headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: 'Bearer synthetic-caller' } : {}) },
      body: method === 'POST' ? JSON.stringify(body) : undefined,
    });
    return { status: result.status, headers: result.headers, body: method === 'OPTIONS' ? null : await result.json() };
  };
  try {
    let stop = await start('bob-read-issues');
    try {
      await t.test('authentication, method and CORS remain intact', async () => {
        assert.equal((await invoke({}, { auth: false })).status, 401);
        assert.equal((await invoke({}, { method: 'GET' })).status, 405);
        assert.equal((await invoke({}, { method: 'OPTIONS' })).headers.get('Access-Control-Allow-Origin'), '*');
        role = 'officer'; assert.equal((await invoke({})).status, 403); role = 'grand_master';
      });
      await t.test('both branch columns deduplicate and select the actionable child without a task run', async () => {
        // Pasted forms seen live: the dash-less workspace suffix, a short id prefix, a dash-less UUID.
        for (const request of [{ iid: branch }, { search: branch }, { iid: rootId }, { iid: childId }, { iid: sha },
          { iid: 'a7c916f5b98047f7ac47' }, { search: 'A7C916F5B98047F7AC47' }, { iid: 'a7c916f5' }, { iid: rootId.replaceAll('-', '') }, { iid: '#f6df4b84' }]) {
          const result = await invoke({ ...request, include_comments: false });
          assert.equal(result.status, 200);
          assert.equal(result.body.issue.iid, childId);
          assert.equal(result.body.selected_job_id, childId);
          assert.equal(result.body.root_job_id, rootId);
          assert.equal(result.body.lineage.length, 2);
          assert.equal(result.body.issue.task_run_id, null);
          assert.equal(result.body.issue.description, 'Synthetic brief');
          assert.deepEqual(result.body.comments, []);
        }
        assert(calls.some(call => call.query.get('branch_name') === `eq.${branch}`));
        assert(calls.some(call => call.query.get('workspace_branch') === `eq.${branch}`));
        assert(!calls.some(call => call.path.includes('bob_task_runs')));
      });
      await t.test('branch-only workspace match, newest actionable descendant, terminal fallback and not-found', async () => {
        jobs[1].branch_name = 'other-branch';
        assert.equal((await invoke({ iid: branch })).body.issue.iid, childId);
        const grandchild = { ...jobs[1], id: '66666666-6666-4666-8666-666666666666', parent_job_id: childId, status: 'testing', created_at: '2026-10-18T00:00:00Z' };
        jobs.push(grandchild);
        assert.equal((await invoke({ iid: branch })).body.issue.iid, grandchild.id);
        jobs.pop(); jobs[1].status = 'failed';
        assert.equal((await invoke({ iid: branch })).body.issue.iid, rootId);
        jobs[1].status = 'implementation_pending';
        const missing = await invoke({ iid: 'bob/job-a7c9165fb98047f7ac47' });
        assert.equal(missing.status, 404);
        assert.equal(missing.body.error, 'Bob job was not found in Builder job records.');
      });
      await t.test('lists retain issue wrapper and database errors cannot become empty success', async () => {
        const list = await invoke({ state: 'implementation_pending' });
        assert.equal(list.body.count, 1); assert.equal(list.body.issues[0].iid, childId);
        dbFailure = true; assert.equal((await invoke({ iid: branch })).status, 500); dbFailure = false;
      });
      await t.test('ambiguous SHA families and unverifiable ancestry fail explicitly', async () => {
        jobs.push({ ...jobs[0], id: '77777777-7777-4777-8777-777777777777', workspace_branch: 'bob/job-unrelated', branch_name: 'unrelated' });
        assert.equal((await invoke({ iid: sha })).status, 400);
        // Exact branch matches take precedence over the shared target SHA.
        assert.equal((await invoke({ iid: branch })).body.selected_job_id, childId);
        jobs.pop();
        jobs[0].parent_job_id = childId;
        assert.equal((await invoke({ iid: branch })).status, 500);
        jobs[0].parent_job_id = null;
        jobs[0].project_id = '88888888-8888-4888-8888-888888888888';
        assert.equal((await invoke({ iid: childId })).status, 500);
        jobs[0].project_id = projectId;
      });
    } finally { await stop(); }
    stop = await start('bob-repo-search');
    try {
      await t.test('repository reads use only the control plane and retain path guards', async () => {
        for (const body of [{ action: 'search', query: 'synthetic' }, { action: 'read', path: 'example.ts' }, { action: 'head' }, { action: 'tree' }]) {
          const result = await invoke(body);
          assert.equal(result.status, 200); assert.notEqual(result.body.ok, false);
        }
        assert.equal((await invoke({ action: 'read', path: '.env' })).status, 403);
        assert.equal((await invoke({ action: 'tree', path: 'docs/JIMS_MEMORIES.md' })).status, 403);
        role = 'officer'; assert.equal((await invoke({ action: 'head' })).status, 403); role = 'grand_master';
        assert.equal((await invoke({ action: 'head' }, { auth: false })).status, 401);
      });
      await t.test('notepad aliases append/read Supabase notes without repository writes', async () => {
        const result = await invoke({ action: 'write_bob_chat', message: 'Synthetic Builder note' });
        assert.equal(result.status, 200); assert.equal(result.body.commit_id, null);
        assert(result.body.memory_id);
        const read = await invoke({ action: 'read_bob_chat' });
        assert.equal(read.body.storage, 'supabase');
        assert.match(read.body.tail_content, /Synthetic Builder note/);
        assert(!calls.some(call => call.path.includes('/repository/commits')));
      });
    } finally { await stop(); }
    stop = await start('bob-dispatch-flow');
    const dispatch = { flow: 'developer', goal: 'Synthetic cutover build', brief: 'Implement only the synthetic fixture change.' };
    try {
      await t.test('dispatch auth and malformed inputs fail before Builder writes', async () => {
        assert.equal((await invoke(dispatch, { auth: false })).status, 401);
        role = 'officer'; assert.equal((await invoke(dispatch)).status, 403); role = 'grand_master';
        assert.equal((await invoke({ ...dispatch, project_id: 'legacy-numeric-project' })).status, 400);
        assert.equal((await invoke({ ...dispatch, target_environment: 'production' })).status, 400);
      });
      await t.test('dispatch sends the actual creation contract then starts the durable job', async () => {
        const result = await invoke(dispatch);
        assert.equal(result.status, 200);
        assert.equal(result.body.workflow_id, '44444444-4444-4444-8444-444444444444');
        assert.equal(result.body.workflow_definition, 'github_builder');
        assert.equal(result.body.runner_started, true);
        const payload = calls.find(call => call.path === '/api/bob/builder/jobs').body;
        assert.deepEqual(payload, {
          repository: 'https://github.com/DonSquires/Field-Compliance-Manager-.git', organizationId: orgId, projectId,
          title: dispatch.goal, taskDescription: dispatch.brief, description: `Confirmed developer dispatch by ${userId}`,
          targetSha: sha, requestedAction: 'prepare_change', targetEnvironment: 'development', branchName: 'main',
          frontendRequired: true, backendRequired: true, codeReviewMode: 'independent_ai', taskRunId: null,
        });
        assert(calls.some(call => call.path === '/rest/v1/rpc/builder_autopilot_bind'));
      });
      await t.test('explicit resume does not create a replacement job; failures preserve its ID', async () => {
        const before = calls.filter(call => call.path === '/api/bob/builder/jobs').length;
        assert.equal((await invoke(dispatch)).body.workflow_id, '44444444-4444-4444-8444-444444444444');
        assert.equal(calls.filter(call => call.path === '/api/bob/builder/jobs').length, before);
        assert.equal((await invoke({ ...dispatch, job_id: childId })).body.workflow_id, childId);
        assert.equal(calls.filter(call => call.path === '/api/bob/builder/jobs').length, before);
        runnerFailure = true;
        const failure = await invoke({ ...dispatch, job_id: childId });
        assert.equal(failure.status, 502); assert.equal(failure.body.workflow_id, childId);
        runnerFailure = false; cpFailure = true;
        assert.equal((await invoke({ ...dispatch, goal: 'A distinct synthetic task' })).status, 502); cpFailure = false;
      });
    } finally { await stop(); }
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
