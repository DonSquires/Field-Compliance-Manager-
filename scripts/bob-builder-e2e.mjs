#!/usr/bin/env node
// Human-test driver for Bob's self-heal lane: opens a Builder job through the
// governed control-room function with the dedicated grand_master test identity,
// runs it, approves the specification gate as that human, and follows it to a
// draft pull request. Prints redacted status only; tokens never leave memory.
//
//   node scripts/bob-builder-e2e.mjs create  "<title>" "<task description>"   -> job id
//   node scripts/bob-builder-e2e.mjs follow  <job_id>                          -> run/poll/approve until release_ready or blocked
//   node scripts/bob-builder-e2e.mjs publish <job_id> <patch_artifact_id>      -> workspace, commit, publish, pull request
//   node scripts/bob-builder-e2e.mjs show    <job_id>
//   node scripts/bob-builder-e2e.mjs cancel  <job_id> "<reason>"
import fs from 'node:fs';

const SUPABASE_URL = process.env.SUPABASE_URL;
const PROJECT_REF = new URL(SUPABASE_URL).hostname.split('.')[0];
const PAT = process.env.SUPABASE_ACCESS_TOKEN ?? process.env.FIELD_COMPLIANCE_CODESPACE;
const EMAIL = process.env.GRANDMASTER_TEST_EMAIL;
const PASSWORD = process.env.GRANDMASTER_TEST_PASSWORD;
const CACHE = '/tmp/.fcm-builder-e2e-session.json';
const ORG = process.env.BOB_BUILDER_ORG_ID || '56710c19-d604-4767-9ad8-9c5863b4ceb7';
const PROJECT = process.env.BOB_BUILDER_PROJECT_ID || 'c53a28b8-6097-4700-a0fd-2b43047e6eeb';

async function anonKey() {
  const r = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/api-keys?reveal=false`, { headers: { Authorization: `Bearer ${PAT}` } });
  if (!r.ok) throw new Error(`api-keys ${r.status}`);
  const keys = await r.json();
  return (keys.find((k) => k.name === 'anon') ?? keys.find((k) => /anon/i.test(k.name))).api_key;
}

async function session({ fresh = false } = {}) {
  if (!fresh) {
    try {
      const cached = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
      if (cached.expires_at - 60 > Date.now() / 1000) return cached;
    } catch {}
  }
  const key = await anonKey();
  const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: key, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
  if (!r.ok) throw new Error(`login ${r.status}`);
  const data = await r.json();
  const s = { access_token: data.access_token, expires_at: data.expires_at, anon: key };
  fs.writeFileSync(CACHE, JSON.stringify(s), { mode: 0o600 });
  return s;
}

async function room(body) {
  const s = await session();
  const payload = JSON.stringify(body);
  const sendRequest = (auth) => fetch(`${SUPABASE_URL}/functions/v1/bob-builder-control-room`, { method: 'POST', headers: { apikey: auth.anon, Authorization: `Bearer ${auth.access_token}`, 'Content-Type': 'application/json' }, body: payload });
  let r = await sendRequest(s);
  if (r.status === 401) r = await sendRequest(await session({ fresh: true }));
  const text = await r.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text.slice(0, 300) }; }
  return { status: r.status, ...parsed };
}

function brief(snapshot) {
  const job = snapshot.job ?? snapshot;
  const steps = (snapshot.steps ?? []).map((s) => `${s.step_id}:${s.status}`).join(' ');
  const artifacts = (snapshot.artifacts ?? []).map((a) => `${a.artifact_type}:${a.status}:${a.id.slice(0, 8)}`).join(' ');
  const approvals = (snapshot.approvals ?? []).map((a) => `${a.approval_type}:${a.status}:${a.id}`).join(' ');
  const autopilot = job.autopilot_state ? `\n  autopilot: ${job.autopilot_state}${job.autopilot_report?.headline ? ` — ${job.autopilot_report.headline}` : ''}${job.workspace_pull_request_url ? ` (${job.workspace_pull_request_url})` : ''}` : '';
  return `status=${job.status} step=${job.current_step_name ?? '-'} error=${job.last_error ?? '-'}\n  steps: ${steps}\n  artifacts: ${artifacts}\n  approvals: ${approvals}${autopilot}`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const HUMAN_APPROVAL_TYPES = new Set(['specification_review', 'release_approval']);
function requireOk(out, action) {
  if (!out || Number(out.status) >= 400 || Number(out.status) < 200) {
    throw new Error(`${action} failed (${out?.status ?? 'no status'}): ${out?.error ?? JSON.stringify(out).slice(0, 300)}`);
  }
  return out;
}
const [cmd, ...args] = process.argv.slice(2);

if (cmd === 'create') {
  const [title, description] = args;
  // E2E_AUTOPILOT=1 hands the job to Bob's autopilot (as the chat path does); otherwise drive it with `follow`.
  const autopilot = process.env.E2E_AUTOPILOT === '1';
  const frontendRequired = process.env.E2E_FRONTEND_REQUIRED === '1';
  const backendRequired = process.env.E2E_BACKEND_REQUIRED !== '0';
  if (!frontendRequired && !backendRequired) throw new Error('create requires at least one implementation lane');
  const out = await room({ action: 'create', organization_id: ORG, project_id: PROJECT, title, task_description: description, description: 'Opened by the Bob self-heal human-test driver.', target_ref: 'main', requested_action: 'prepare_change', target_environment: 'development', code_review_mode: 'independent_ai', frontend_required: frontendRequired, backend_required: backendRequired, ...(autopilot ? { autopilot: true } : {}) });
  console.log(out.status, out.job ? `${out.duplicate ? 'already underway: ' : ''}job ${out.job.id} status=${out.job.status} target=${String(out.job.target_sha).slice(0, 10)} autopilot=${out.autopilot === true ? out.job.autopilot_state ?? 'bound' : 'off'}${out.autopilot_error ? ` (${out.autopilot_error})` : ''}` : JSON.stringify(out));
} else if (cmd === 'show') {
  const out = await room({ action: 'get', job_id: args[0] });
  console.log(brief(out));
} else if (cmd === 'run') {
  const out = await room({ action: 'run', job_id: args[0], max_actions: Number(args[1] || 1) });
  const runtime = out.run ?? out.result ?? out;
  console.log(`status=${out.status} error=${out.error ?? '-'} paused=${runtime.paused ?? '-'} reason=${runtime.reason ?? '-'} skipped=${runtime.skipped ?? '-'} already_running=${runtime.already_running ?? '-'} action=${runtime.action?.type ?? '-'}`);
} else if (cmd === 'cancel') {
  const [jobId, reason] = args;
  const out = await room({ action: 'cancel', job_id: jobId, reason });
  console.log(out.job ? brief(out) : `status=${out.status} error=${out.error ?? '-'}`);
} else if (cmd === 'approve') {
  // The human's click for ONE pending gate (e.g. an evidential hold); the autopilot resumes on its own.
  const [jobId, comment] = args;
  const snap = await room({ action: 'get', job_id: jobId });
  const pendingApproval = (snap.approvals ?? []).find((a) => a.status === 'pending');
  if (!pendingApproval) { console.log('no pending approval'); process.exit(1); }
  const decided = await room({ action: 'decide_approval', job_id: jobId, approval_id: pendingApproval.id, decision: 'approved', comment: comment || 'Approved by the human test driver.' });
  console.log('approval', pendingApproval.approval_type, decided.status, decided.error ?? 'approved');
} else if (cmd === 'follow') {
  const jobId = args[0];
  const deadline = Date.now() + Number(process.env.E2E_BUDGET_MIN || 90) * 60_000;
  let lastStatus = '';
  while (Date.now() < deadline) {
    const snap = await room({ action: 'get', job_id: jobId });
    if (snap.status !== 200) { console.log('get failed', snap.status, snap.error); break; }
    const state = brief(snap);
    if (state !== lastStatus) { console.log(new Date().toISOString(), state); lastStatus = state; }
    const status = snap.job.status;
    if (['release_ready', 'deployed', 'failed', 'cancelled'].includes(status)) break;
    const pendingApproval = (snap.approvals ?? []).find((a) => a.status === 'pending');
    if (pendingApproval) {
      if (!HUMAN_APPROVAL_TYPES.has(pendingApproval.approval_type)) {
        throw new Error(`Refusing to approve unexpected Builder gate: ${pendingApproval.approval_type ?? 'unknown'}`);
      }
      const decided = await room({ action: 'decide_approval', job_id: jobId, approval_id: pendingApproval.id, decision: 'approved', comment: 'Human test driver: brief confirmed by the owner in chat; specification approved to let the agentic lane implement, test, and review.' });
      requireOk(decided, `approve ${pendingApproval.approval_type}`);
      console.log('approval', pendingApproval.approval_type, decided.status, decided.error ?? 'approved');
      await sleep(3000);
      continue;
    }
    const run = await room({ action: 'run', job_id: jobId, max_actions: 8 });
    if (run.status >= 400) console.log('run', run.status, run.error ?? JSON.stringify(run).slice(0, 200));
    await sleep(Number(process.env.E2E_POLL_MS || 30_000));
  }
} else if (cmd === 'publish') {
  const [jobId, artifactId] = args;
  if (!jobId || !artifactId) throw new Error('publish requires a job id and final verified patch artifact id');
  for (const step of [{ action: 'create_workspace' }, { action: 'commit_verified_patch', artifact_id: artifactId }, { action: 'publish_workspace' }, { action: 'create_pull_request' }]) {
    const out = await room({ action: step.action, job_id: jobId, ...(step.artifact_id ? { artifact_id: step.artifact_id } : {}) });
    requireOk(out, step.action);
    console.log(step.action, out.status, JSON.stringify(out).slice(0, 300));
  }
  const final = requireOk(await room({ action: 'get', job_id: jobId }), 'get published Builder job');
  const job = final.job ?? {};
  if (!job.workspace_head_sha || !job.workspace_published_head_sha || !job.workspace_pull_request_head_sha) {
    throw new Error('Builder publish completed without workspace, published, and pull-request head SHAs');
  }
  if (job.workspace_head_sha !== job.workspace_published_head_sha || job.workspace_published_head_sha !== job.workspace_pull_request_head_sha) {
    throw new Error(`Builder SHA mismatch: workspace=${job.workspace_head_sha} published=${job.workspace_published_head_sha} pr=${job.workspace_pull_request_head_sha}`);
  }
  console.log(`publish verified: commit=${job.workspace_head_sha} pr=${job.workspace_pull_request_url ?? 'missing URL'}`);
} else if (cmd === 'chat') {
  // One chat turn as the dedicated test identity. Default: the Bob Builder chat lane.
  // E2E_AGENT_MODE=operations sends one in-app Bob turn exactly as BobPanel does.
  const s = await session();
  const rest = (path, init = {}) => fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...init, headers: { apikey: s.anon, Authorization: `Bearer ${s.access_token}`, 'Content-Type': 'application/json', Prefer: 'return=representation', ...(init.headers ?? {}) } });
  const authenticatedUserId = JSON.parse(Buffer.from(s.access_token.split('.')[1], 'base64url').toString('utf8')).sub;
  const profile = await (await rest(`user_profiles?select=id,organization_id&id=eq.${encodeURIComponent(authenticatedUserId)}&limit=1`)).json();
  const { id: userId, organization_id: organizationId } = profile[0];
  const agentMode = process.env.E2E_AGENT_MODE === 'operations' ? 'operations' : 'builder';
  if (agentMode === 'builder') {
    // The Bob Builder chat is its own lane (builder_chat_* RPCs answered by the control-plane
    // worker); the in-app onspace-ai-chat refuses builder turns.
    const rpc = async (name, body) => {
      const response = await rest(`rpc/${name}`, { method: 'POST', body: JSON.stringify(body) });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(`${name} ${response.status}: ${payload?.message ?? JSON.stringify(payload)}`);
      return payload;
    };
    const threadId = process.env.E2E_THREAD || await rpc('builder_chat_thread_open', { p_title: 'E2E Bob Builder chat' });
    const messageId = await rpc('builder_chat_send', { p_thread_id: threadId, p_content: args.join(' ') || 'What is waiting on me across Builder jobs?', p_client_request_id: crypto.randomUUID(), p_context: { surface: 'e2e' } });
    let owner;
    for (let attempt = 0; attempt < 120; attempt++) {
      await sleep(2_500);
      [owner] = await (await rest(`builder_chat_messages?select=status&id=eq.${encodeURIComponent(messageId)}`)).json();
      if (['done', 'failed'].includes(owner?.status)) break;
    }
    const rows = await (await rest(`builder_chat_messages?select=role,kind,content,payload&thread_id=eq.${encodeURIComponent(threadId)}&order=seq.asc`)).json();
    const turn = rows.filter(row => row.payload?.message_id === messageId || row.role === 'tool');
    console.log('thread', threadId, 'message', messageId, 'status', owner?.status ?? 'timeout');
    for (const row of turn) console.log(`[${row.role}/${row.kind}] ${String(row.content).slice(0, 1500)}`);
    if (owner?.status !== 'done') process.exitCode = 1;
  } else {
  // E2E_CONVERSATION=<id> continues an earlier turn (e.g. answering "yes" to a composed brief).
  let conversationId = process.env.E2E_CONVERSATION || '';
  if (!conversationId) {
    const created = await (await rest('bob_conversations', { method: 'POST', body: JSON.stringify([{ organization_id: organizationId, user_id: userId, module_key: agentMode, title: 'E2E Bob runtime check' }]) })).json();
    conversationId = created[0].id;
  }
  const r = await fetch(`${SUPABASE_URL}/functions/v1/onspace-ai-chat`, { method: 'POST', headers: { apikey: s.anon, Authorization: `Bearer ${s.access_token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ operation: 'enqueue', request_id: crypto.randomUUID(), message: args.join(' ') || 'Hi Bob — anything to report?', conversation_id: conversationId, attachments: [], context: { agent_mode: agentMode, organization_id: organizationId } }) });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 500) }; }
  if (r.status === 202 && data.turn_run?.request_id) {
    for (let attempt = 0; attempt < 60; attempt++) {
      await sleep(2_500);
      const statusResponse = await fetch(`${SUPABASE_URL}/functions/v1/onspace-ai-chat`, {
        method: 'POST',
        headers: { apikey: s.anon, Authorization: `Bearer ${s.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          operation: 'status',
          request_id: data.turn_run.request_id,
          conversation_id: conversationId,
          context: { agent_mode: agentMode, organization_id: organizationId },
        }),
      });
      const statusData = await statusResponse.json();
      if (statusData.turn_run?.status === 'completed') {
        const messages = await (await rest(`bob_messages?select=content,metadata&conversation_id=eq.${encodeURIComponent(conversationId)}&role=eq.assistant&order=created_at.desc&limit=1`)).json();
        data = { reply: messages[0]?.content, meta: messages[0]?.metadata, turn_run: statusData.turn_run };
        break;
      }
      if (['failed', 'cancelled'].includes(statusData.turn_run?.status)) {
        data = statusData;
        break;
      }
    }
  }
  console.log('status', r.status, 'conversation', conversationId);
  console.log('--- reply ---');
  console.log(String(data.reply ?? data.message ?? data.raw ?? JSON.stringify(data)).slice(0, 4000));
  if (data.meta) console.log('--- meta ---', JSON.stringify({
    intent: data.meta.intent,
    route: data.meta.route_selected,
    planned_tool: data.meta.planned_tool,
    reasoning_steps: data.meta.reasoning_steps,
    verification: data.meta.verification?.status,
  }).slice(0, 1600));
  }
} else {
  console.log('usage: create <title> <description> | follow <job_id> | publish <job_id> <artifact_id> | show <job_id> | cancel <job_id> "<reason>" | approve <job_id> "<comment>" | chat <message>');
  process.exit(2);
}
