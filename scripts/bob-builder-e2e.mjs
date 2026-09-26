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
const PAT = process.env.FIELD_COMPLIANCE_CODESPACE;
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
const [cmd, ...args] = process.argv.slice(2);

if (cmd === 'create') {
  const [title, description] = args;
  // E2E_AUTOPILOT=1 hands the job to Bob's autopilot (as the chat path does); otherwise drive it with `follow`.
  const autopilot = process.env.E2E_AUTOPILOT === '1';
  const out = await room({ action: 'create', organization_id: ORG, project_id: PROJECT, title, task_description: description, description: 'Opened by the Bob self-heal human-test driver.', target_ref: 'main', requested_action: 'prepare_change', target_environment: 'development', code_review_mode: 'independent_ai', frontend_required: false, backend_required: true, ...(autopilot ? { autopilot: true } : {}) });
  console.log(out.status, out.job ? `${out.duplicate ? 'already underway: ' : ''}job ${out.job.id} status=${out.job.status} target=${String(out.job.target_sha).slice(0, 10)} autopilot=${out.autopilot === true ? out.job.autopilot_state ?? 'bound' : 'off'}${out.autopilot_error ? ` (${out.autopilot_error})` : ''}` : JSON.stringify(out));
} else if (cmd === 'show') {
  const out = await room({ action: 'get', job_id: args[0] });
  console.log(brief(out));
} else if (cmd === 'cancel') {
  const [jobId, reason] = args;
  const out = await room({ action: 'cancel', job_id: jobId, reason });
  console.log(out.job ? brief(out) : `status=${out.status} error=${out.error ?? '-'}`);
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
      const decided = await room({ action: 'decide_approval', job_id: jobId, approval_id: pendingApproval.id, decision: 'approved', comment: 'Human test driver: brief confirmed by the owner in chat; specification approved to let the agentic lane implement, test, and review.' });
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
  for (const step of [{ action: 'create_workspace' }, { action: 'commit_verified_patch', artifact_id: artifactId }, { action: 'publish_workspace' }, { action: 'create_pull_request' }]) {
    const out = await room({ action: step.action, job_id: jobId, ...(step.artifact_id ? { artifact_id: step.artifact_id } : {}) });
    console.log(step.action, out.status, JSON.stringify(out).slice(0, 300));
    if (out.status >= 400) break;
  }
} else if (cmd === 'chat') {
  // One chat turn as the dedicated test identity, exactly as BobPanel sends it. Proves the
  // autopilot report relay: Bob must lead with any unreported outcome for this person.
  const s = await session();
  const rest = (path, init = {}) => fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...init, headers: { apikey: s.anon, Authorization: `Bearer ${s.access_token}`, 'Content-Type': 'application/json', Prefer: 'return=representation', ...(init.headers ?? {}) } });
  const profile = await (await rest('user_profiles?select=id,organization_id&limit=1')).json();
  const { id: userId, organization_id: organizationId } = profile[0];
  const created = await (await rest('bob_conversations', { method: 'POST', body: JSON.stringify([{ organization_id: organizationId, user_id: userId, module_key: 'operations', title: 'E2E autopilot relay check' }]) })).json();
  const conversationId = created[0].id;
  const r = await fetch(`${SUPABASE_URL}/functions/v1/onspace-ai-chat`, { method: 'POST', headers: { apikey: s.anon, Authorization: `Bearer ${s.access_token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ message: args.join(' ') || 'Hi Bob — anything to report?', conversation_id: conversationId, attachments: [], context: { agent_mode: 'operations' } }) });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 500) }; }
  console.log('status', r.status, 'conversation', conversationId);
  console.log('--- reply ---');
  console.log(String(data.reply ?? data.message ?? data.raw ?? JSON.stringify(data)).slice(0, 4000));
  if (data.meta) console.log('--- meta ---', JSON.stringify({ intent: data.meta.intent, route: data.meta.route_selected, verification: data.meta.verification?.status }).slice(0, 400));
} else {
  console.log('usage: create <title> <description> | follow <job_id> | publish <job_id> <artifact_id> | show <job_id> | cancel <job_id> "<reason>" | chat <message>');
  process.exit(2);
}
