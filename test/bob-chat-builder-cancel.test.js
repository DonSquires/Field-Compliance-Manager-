'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const chat = fs.readFileSync('supabase/functions/onspace-ai-chat/index.ts', 'utf8');
const caddie = fs.readFileSync('supabase/functions/onspace-ai-chat/caddie.ts', 'utf8');
const planner = require('../services/fcm-api/src/bob/planPrompt.js');

const stripTypeAnnotations = (source) => source
  .replace(/([A-Za-z_$][\w$]*)\s*:\s*(?:string\|string\[\]|string\[\]|string|number|boolean|unknown|any|Array<[^>]+>|Record<[^>]+>)(?=\s*(?:,|\)|=>))/g, '$1')
  .replace(/:\s*(?:string\|string\[\]|string\[\]|string|number|boolean|unknown|any|Array<[^>]+>|Record<[^>]+>)/g, '');

const historySource = chat.slice(chat.indexOf('async function loadHistory('), chat.indexOf('// Bob\'s per-user memory', chat.indexOf('async function loadHistory(')));
assert.ok(historySource.startsWith('async function loadHistory('));
const loadHistory = vm.runInNewContext(`${stripTypeAnnotations(historySource)}\nloadHistory`);
const proposal = { job_id: '12345678-1234-1234-1234-123456789abc', title: 'Fix build', reason: 'No longer needed', user_id: 'owner', conversation_id: 'thread' };
const assistant = (metadata) => ({ role: 'assistant', content: 'preview', metadata });
const cancel = (outcome) => assistant({ tool: 'cancel_builder_job', outcome, pending_builder_cancellation: proposal });
const user = { role: 'user', content: 'yes' };
const laptop = assistant({ tool: 'laptop_shell', pending_laptop_command: { command: 'pwd', purpose: 'inspect' }, outcome: 'proposed' });
const builder = assistant({ tool: 'create_builder_job', pending_builder_job: { title: 'Build' }, outcome: 'proposed' });
async function recover(chronological) {
  const supabase = { from: (table) => {
    assert.equal(table, 'bob_messages');
    return { select() { return this; }, eq() { return this; }, order() { return this; }, async limit() { return { data: chronological.slice().reverse() }; } };
  } };
  return loadHistory(supabase, 'thread');
}

test('a newest proposed cancellation is recovered on the confirmation turn without a ReferenceError', async () => {
  const { pending } = await recover([user, cancel('proposed')]);
  assert.equal(pending.kind, 'builder_cancellation_pending');
  assert.equal(pending.builder_cancellation.job_id, proposal.job_id);
});

test('a tied-timestamp USER row after the newest ASSISTANT proposal does not hide cancellation', async () => {
  const created_at = '2026-09-27T05:27:41.616Z';
  const request = { role: 'user', content: 'Cancel this Builder job', created_at };
  const preview = { ...cancel('proposed'), created_at };
  const { pending } = await recover([preview, request]);
  assert.equal(pending.kind, 'builder_cancellation_pending');
  assert.equal(pending.builder_cancellation.job_id, proposal.job_id);
  assert.equal((await recover([request, preview])).pending.kind, 'builder_cancellation_pending');
});

const branch = stripTypeAnnotations(chat.slice(chat.indexOf("case 'cancel_builder_job':"), chat.indexOf("case 'laptop_shell':")));
const matcherStart = chat.indexOf('    const builderCancellationDecision = ');
assert.ok(matcherStart >= 0);
const matcher = stripTypeAnnotations(chat.slice(matcherStart, chat.indexOf('    /** Dispatch a single tool', matcherStart)));
const routeStart = chat.indexOf("    if (pending?.kind === 'builder_cancellation_pending' && builderCancellationDecision(message)) {");
assert.ok(routeStart >= 0);
const route = chat.slice(routeStart, chat.indexOf('    // ── Plan call', routeStart));
const makeFlow = vm.runInNewContext(`(env) => {
  const { caps, pending, user, conversationId, message, callFn, authHeader, createClient,
    persist, admin, orgId, startTime, json, respond, buildStructuredResponse } = env;
  ${matcher}
  const dispatchTool = async (tool, toolArgs) => {
    switch (tool) {
      ${branch}
      default: throw new Error('Unexpected tool');
    }
  };
  const confirm = async () => {
    ${route}
    return null;
  };
  return { dispatchTool, confirm };
}`, { Deno: { env: { get: () => '' } } });

test('a tied-timestamp preview followed by yes uses the cancellation route, not another preview', async () => {
  const events = [];
  const savedTurns = [];
  const env = {
    caps: { tier: 'admiral' }, pending: null, user: { id: proposal.user_id },
    conversationId: proposal.conversation_id, message: 'Cancel this Builder job',
    authHeader: 'test-auth', admin: {}, orgId: 'test-org', startTime: 0,
    callFn: async (name, header, body) => {
      assert.equal(name, 'bob-builder-control-room');
      assert.equal(header, env.authHeader);
      assert.equal(body.action, 'list');
      events.push('list');
      return { ok: true, data: { jobs: [{ id: proposal.job_id, title: proposal.title, status: 'running' }] } };
    },
    createClient: (_url, _key, options) => {
      assert.equal(options.global.headers.Authorization, env.authHeader);
      return { rpc: async (name, args) => {
        assert.equal(name, 'builder_cancel_job');
        assert.equal(args._job_id, proposal.job_id);
        assert.equal(args._reason, proposal.reason);
        events.push('rpc');
        return { data: { id: proposal.job_id, status: 'cancelled' }, error: null };
      } };
    },
    persist: async (_admin, _orgId, _conversationId, turns) => { savedTurns.push(turns); events.push('persist'); },
    json: (result) => result,
    respond: (result) => result,
    buildStructuredResponse: (result) => result,
  };
  const preview = await makeFlow(env).dispatchTool('cancel_builder_job', { job_id: proposal.job_id, reason: proposal.reason });
  assert.equal(preview.meta.outcome, 'proposed');
  assert.match(preview.reply, /Preview only/);
  const created_at = '2026-09-27T05:27:41.616Z';
  env.pending = (await recover([
    { role: 'assistant', content: preview.reply, metadata: preview.meta, created_at },
    { role: 'user', content: env.message, created_at },
  ])).pending;
  env.message = 'yes';
  const confirmation = await makeFlow(env).confirm();
  assert.equal(confirmation.meta.outcome, 'cancelled');
  assert.match(confirmation.reply, /^Cancelled Builder job/);
  assert.deepEqual(events, ['list', 'list', 'rpc', 'persist']);
  assert.equal(savedTurns[0][1].metadata.outcome, 'cancelled');
});

test('pending Builder cancellation consumes only bounded confirmation and decline phrases', async () => {
  for (const [expected, phrases] of [
    ['cancelled', ['yes', 'yes please', 'yep', 'yeah', 'go ahead', 'do it', 'confirm', 'cancel it']],
    ['declined', ['no', 'stop', "don't", 'leave it']],
  ]) {
    for (const message of phrases) {
      const calls = [];
      const env = {
        caps: { tier: 'admiral' }, pending: { kind: 'builder_cancellation_pending', builder_cancellation: proposal },
        user: { id: proposal.user_id }, conversationId: proposal.conversation_id, message,
        authHeader: 'test-auth', admin: {}, orgId: 'test-org', startTime: 0,
        callFn: async (name, header, body) => {
          assert.equal(name, 'bob-builder-control-room');
          assert.equal(header, 'test-auth');
          assert.equal(body.action, 'list');
          calls.push('list');
          return { ok: true, data: { jobs: [{ id: proposal.job_id, title: proposal.title, status: 'running' }] } };
        },
        createClient: (_url, _key, options) => {
          assert.equal(options.global.headers.Authorization, 'test-auth');
          return { rpc: async (name, args) => {
            assert.equal(name, 'builder_cancel_job');
            assert.equal(args._job_id, proposal.job_id);
            assert.equal(args._reason, proposal.reason);
            calls.push('rpc');
            return { data: { id: proposal.job_id, status: 'cancelled' }, error: null };
          } };
        },
        persist: async (_admin, _orgId, _conversationId, turns) => {
          calls.push('persist');
          assert.equal(turns[1].metadata.outcome, expected);
        },
        json: (result) => result,
        respond: (result) => result,
        buildStructuredResponse: (result) => result,
      };
      const result = await makeFlow(env).confirm();
      assert.equal(result.meta.outcome, expected, message);
      assert.deepEqual(calls, expected === 'cancelled' ? ['list', 'rpc', 'persist'] : ['persist'], message);
    }
  }
  for (const message of ['What is the job status?', 'yes please do not cancel', 'cancel it later', 'no, cancel it']) {
    const env = {
      pending: { kind: 'builder_cancellation_pending', builder_cancellation: proposal }, message,
      caps: { tier: 'admiral' }, user: { id: proposal.user_id }, conversationId: proposal.conversation_id,
      callFn: () => { throw new Error('Non-decision must not list Builder jobs'); },
      createClient: () => { throw new Error('Non-decision must not cancel Builder jobs'); },
      persist: () => { throw new Error('Non-decision must not be consumed'); },
    };
    const flow = makeFlow(env);
    assert.equal(await flow.confirm(), null, message);
    assert.equal((await flow.dispatchTool('cancel_builder_job', {})).meta.outcome, 'unconfirmed', message);
  }
});

test('a proposed cancellation followed by another ASSISTANT row is ignored', async () => {
  assert.equal((await recover([cancel('proposed'), user, assistant({})])).pending, null);
  assert.equal((await recover([cancel('proposed'), user, builder])).pending.kind, 'builder_job_pending');
});

test('declined or consumed cancellation markers do not mask other pending kinds', async () => {
  for (const outcome of ['declined', 'consumed']) {
    assert.equal((await recover([laptop, cancel(outcome), user])).pending.kind, 'laptop_command_pending');
    assert.equal((await recover([builder, cancel(outcome), user])).pending.kind, 'builder_job_pending');
    assert.equal((await recover([cancel(outcome)])).pending, null);
  }
});

test('old proposed cancellation is skipped when scanning past it for another pending kind', async () => {
  assert.equal((await recover([cancel('proposed'), laptop, user])).pending.kind, 'laptop_command_pending');
  assert.equal((await recover([cancel('proposed'), builder, user])).pending.kind, 'builder_job_pending');
});

test('the control-room list data is narrowed before jobs are read', () => {
  const branch = chat.slice(chat.indexOf("case 'cancel_builder_job':"), chat.indexOf("case 'laptop_shell':"));
  assert.match(branch, /callFn\('bob-builder-control-room', authHeader, \{ action: 'list' \}\)/);
  assert.doesNotMatch(branch, /\.from\(['"]builder_jobs['"]\)/);
  const expression = branch.match(/const jobs = ([^;]+);/);
  assert.ok(expression);
  const parseJobs = vm.runInNewContext(`(listed) => ${expression[1]}`);
  for (const data of [undefined, null, 0, '', [], {}, { jobs: null }, { jobs: {} }]) {
    assert.equal(parseJobs({ ok: true, data }), null);
  }
  const jobs = [{ id: proposal.job_id }];
  assert.equal(parseJobs({ ok: true, data: { jobs } }), jobs);
  assert.match(branch, /if \(!listed\.ok \|\| !jobs\) return \{ reply: .*No cancellation was made\./);
  assert.ok(branch.indexOf('if (!listed.ok || !jobs)') < branch.indexOf('jobs.filter('));
});

test('preview, caller RPC, immediate consumption and deterministic routing remain wired', () => {
  const branch = chat.slice(chat.indexOf("case 'cancel_builder_job':"), chat.indexOf("case 'laptop_shell':"));
  assert.ok(branch.indexOf('if (!stored) {') < branch.indexOf("callerClient.rpc('builder_cancel_job'"));
  assert.match(branch, /pending_builder_cancellation: \{ job_id: job\.id, title: job\.title, reason, user_id: user\.id, conversation_id: conversationId \}/);
  assert.match(branch, /createClient\(Deno\.env\.get\('SUPABASE_URL'\).*Authorization: authHeader/);
  assert.match(branch, /callerClient\.rpc\('builder_cancel_job', \{ _job_id: jobId, _reason: reason \}\)/);
  assert.match(branch, /const cancellationDecision = builderCancellationDecision\(message\)/);
  assert.match(branch, /if \(stored && cancellationDecision !== 'confirm'\)/);
  const immediate = chat.slice(routeStart, chat.indexOf('    const plan = await callPlan(planPayload);'));
  assert.match(immediate, /builderCancellationDecision\(message\)/);
  assert.match(immediate, /dispatchTool\('cancel_builder_job', \{\}/);
  assert.match(immediate, /await persist\(admin, orgId, conversationId, \[/);
  assert.match(immediate, /return respond\(buildStructuredResponse\(/);
  assert.match(chat, /pending\.builder_cancellation\?\.user_id === user\.id && pending\.builder_cancellation\?\.conversation_id === conversationId\) \{\s*decision = \{ action: 'use_tool', tool: 'cancel_builder_job', args: \{\} \}/);
  assert.match(caddie, /cancel_builder_job: \{/);
  assert.match(planner.buildPendingBlock({ kind: 'builder_cancellation_pending', builder_cancellation: proposal }), /RESUME — BUILDER CANCELLATION AWAITING CONFIRMATION:[\s\S]*cancel_builder_job/);
});
