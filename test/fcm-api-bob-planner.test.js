'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildPendingBlock, buildPlannerPrompt, buildPlannerMessages, buildTaskStateBlock, buildMemoryBlock, buildRulingsAndNotesBlock, sliceWithDisclosure } = require('../services/fcm-api/src/bob/planPrompt');
const { normalizeDecision, parsePlanContent } = require('../services/fcm-api/src/bob/planParse');
const { autoRepairArgs, runDeterministicChecks, scrubReply, parseCriticContent } = require('../services/fcm-api/src/bob/verify');
const { planTurn } = require('../services/fcm-api/src/bob/plan');
const { createModelGateway, isReasoningModel, paramsUnsupportedError } = require('../services/fcm-api/src/bob/modelGateway');

const TOOLS = [
  { tool: 'query_records', purpose: 'Look up records' },
  { tool: 'web_research', purpose: 'Governed web research' },
  { tool: 'retrieve_knowledge', purpose: 'Knowledge cards' },
  { tool: 'propose_client_onboarding', purpose: 'Propose a client', governance: 'WRITE-draft' },
];

test('parsePlanContent recovers JSON from fences and surrounding prose, rejects arrays', () => {
  assert.deepEqual(parsePlanContent('{"action":"answer"}'), { action: 'answer' });
  assert.deepEqual(parsePlanContent('```json\n{"action":"ask"}\n```'), { action: 'ask' });
  assert.deepEqual(parsePlanContent('Sure. {"action":"use_tool","args":{"a":"}"}} done'), { action: 'use_tool', args: { a: '}' } });
  assert.equal(parsePlanContent('[1,2]'), null);
});

test('normalizeDecision keeps only catalogue tools, one question, and delegable subagents', () => {
  const useTool = normalizeDecision({ action: 'usetool', tool: 'QueryRecords', args: { query: 'find_org' } }, TOOLS);
  assert.equal(useTool.action, 'use_tool');
  assert.equal(useTool.tool, 'query_records');

  const rejected = normalizeDecision({ action: 'use_tool', tool: 'run_sql', reply: 'checking' }, TOOLS);
  assert.equal(rejected.action, 'answer');
  assert.equal(rejected.planned_tool_rejected, 'run_sql');

  const ask = normalizeDecision({ action: 'ask', questions: [{ question: 'Casual or part-time?', best_guess: 'casual' }, { question: 'Region?' }] }, TOOLS);
  assert.equal(ask.action, 'ask');
  assert.equal(ask.questions.length, 1);
  assert.equal(ask.dropped_questions, 1);

  const emptyAsk = normalizeDecision({ action: 'ask', reply: 'hmm', questions: [] }, TOOLS);
  assert.equal(emptyAsk.action, 'answer');

  const delegate = normalizeDecision({ action: 'delegate', subagents: [{ role: 'research', goal: 'NZ COA requirements', tools: ['web_research', 'propose_client_onboarding'] }] }, TOOLS, { delegableTools: ['web_research', 'query_records'] });
  assert.equal(delegate.action, 'delegate');
  assert.deepEqual(delegate.subagents[0].tools, ['web_research']);
  assert.equal(delegate.route_selected, 'delegate');

  const delegateWithoutTools = normalizeDecision({ action: 'delegate', subagents: [{ role: 'research', goal: 'x', tools: ['propose_client_onboarding'] }], reply: 'fallback' }, TOOLS, { delegableTools: ['web_research'] });
  assert.equal(delegateWithoutTools.action, 'answer');
});

test('pending ask block carries the earlier questions and the blanket-answer rule', () => {
  const block = buildPendingBlock({ kind: 'ask', questions: [{ question: 'Include a 90-day trial clause?', best_guess: 'yes' }] });
  assert.match(block, /IN-FLIGHT PLAN/);
  assert.match(block, /90-day trial clause/);
  assert.match(block, /BLANKET ANSWERS/);
  assert.match(block, /Do NOT re-ask/);
});

test('planner prompt exposes drafting discipline, one-question rule, and delegation only when delegable tools exist', () => {
  const prompt = buildPlannerPrompt({ message: 'draft a job description', tools: TOOLS });
  assert.match(prompt, /DRAFTING DISCIPLINE/);
  assert.match(prompt, /ONE QUESTION RULE/);
  assert.match(prompt, /DELEGATE bounded sub-tasks/);
  assert.match(prompt, /"delegate"/);
  const noDelegate = buildPlannerPrompt({ message: 'hi', tools: [{ tool: 'propose_client_onboarding', purpose: 'x' }] });
  assert.doesNotMatch(noDelegate, /DELEGATE bounded/);
  const messages = buildPlannerMessages({ message: 'hi', tools: TOOLS, persona: '[PERSONA] test', platformContext: '[PLATFORM] test', history: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b', metadata: { x: 1 } }] });
  assert.equal(messages[0].role, 'system');
  assert.match(messages[0].content, /\[PERSONA\] test/);
  assert.equal(messages.length, 4);
  assert.equal(messages[2].role, 'assistant');
});

test('completed autopilot work is relayed first, in plain language, and the rule forbids merge/deploy claims', () => {
  const { buildCompletedWorkBlock } = require('../services/fcm-api/src/bob/planPrompt');
  assert.equal(buildCompletedWorkBlock([]), '');
  const block = buildCompletedWorkBlock([{ state: 'published', title: "Accept 'go for it' as a yes", pull_request_url: 'https://git.example/pulls/9', report: 'Done: built, checked, waiting for review.' }]);
  assert.match(block, /COMPLETED WORK TO REPORT/);
  assert.match(block, /\[published\] Accept 'go for it' as a yes — review link: https:\/\/git\.example\/pulls\/9/);
  assert.match(block, /Done: built, checked, waiting for review\./);
  assert.match(block, /RELAY RULE: open your reply with a short plain-language report/);
  assert.match(block, /Never claim anything was merged or deployed/);
  const prompt = buildPlannerPrompt({ message: 'hi', tools: TOOLS, completedWork: [{ state: 'blocked', title: 'T', report: 'Stopped: needs a person.' }] });
  assert.match(prompt, /\[blocked\] T\n\s+Stopped: needs a person\./);
  // readBody carries the conductor's completed_work through to the prompt input.
  const { readBody } = require('../services/fcm-api/src/bob/plan');
  assert.deepEqual(readBody({ completed_work: [{ state: 'published', title: 'x' }, 'junk', null] }).completedWork, [{ state: 'published', title: 'x' }]);
});

test('task state renders subagent results and truncation disclosure', () => {
  const block = buildTaskStateBlock({ goal: 'g', subagent_results: [{ role: 'research', goal: 'COA', findings: 'Green COA is issued by the PSPLA.', sources: ['https://www.pspla.govt.nz'], confidence: 0.8, steps: [{ tool: 'web_research', outcome: 'ok' }] }] });
  assert.match(block, /DELEGATION COMPLETE/);
  assert.match(block, /pspla\.govt\.nz/);
  assert.match(block, /Do NOT delegate the same goal again/);
  const sliced = sliceWithDisclosure('x'.repeat(50), 10, 'thing');
  assert.match(sliced, /TRUNCATED: thing was 50 chars/);
});

test('memory block hides identifiers and knowledge cards, keeps who the user is', () => {
  const block = buildMemoryBlock({ display_name: 'Don', tier: 'admiral', organization_id: 'abc', knowledge_cards: [{}], conversation_id: 'x', organization_name: 'R & M Security' });
  assert.match(block, /display_name: Don/);
  assert.match(block, /organization_name: R & M Security/);
  assert.doesNotMatch(block, /organization_id/);
  assert.doesNotMatch(block, /knowledge_cards/);
});

test('deterministic checks catch questionnaires, re-asks after a blanket answer, leaks, and tool misuse', () => {
  const pending = { kind: 'ask', questions: [{ question: 'Do you want a 90-day trial clause?' }, { question: 'Own vehicle between sites?' }] };
  for (const message of ['yes to all', 'all good with me', 'Crack on!']) {
    const reAsk = runDeterministicChecks({ action: 'ask', reply: 'Great.', questions: [{ question: 'Do you want a 90 day trial clause included?' }], args: {} }, { message, pending });
    assert.ok(reAsk.some((issue) => issue.code === 're_ask_after_blanket_answer' && issue.severity === 'block'));
  }

  const goForIt = runDeterministicChecks({ action: 'ask', reply: 'Great.', questions: [{ question: 'Do you want a 90 day trial clause included?' }], args: {} }, { message: 'go for it', pending });
  assert.ok(goForIt.some((issue) => issue.code === 're_ask_after_blanket_answer' && issue.severity === 'block'));

  const yesPlease = runDeterministicChecks({ action: 'ask', reply: 'Great.', questions: [{ question: 'Do you want a 90 day trial clause included?' }], args: {} }, { message: 'Yes please!', pending });
  assert.ok(yesPlease.some((issue) => issue.code === 're_ask_after_blanket_answer' && issue.severity === 'block'));

  const questionnaire = runDeterministicChecks({ action: 'answer', reply: '1. Casual?\n2. Region?\n3. Trial clause?\n4. Vehicle?', questions: [], args: {} }, { message: 'draft an agreement', pending: null });
  assert.ok(questionnaire.some((issue) => issue.code === 'questionnaire'));

  const leak = runDeterministicChecks({ action: 'answer', reply: '[INTERNAL: x] org 123e4567-e89b-42d3-a456-426614174000 column "foo" does not exist', questions: [], args: {} }, { message: 'hi' });
  assert.deepEqual(leak.filter((issue) => issue.severity === 'block').map((issue) => issue.code).sort(), ['internal_marker_leak', 'sql_error_leak', 'uuid_leak']);

  const falseClaim = runDeterministicChecks({ action: 'answer', reply: 'Done — the client has been created and filed.', questions: [], args: {} }, { message: 'create the client' });
  assert.ok(falseClaim.some((issue) => issue.code === 'false_completion_claim'));

  const stalled = runDeterministicChecks({ action: 'ask', reply: 'Before I draft:', questions: [{ question: 'Which region?' }], args: {} }, { message: 'please draft a job description for a casual security officer' });
  assert.ok(stalled.some((issue) => issue.code === 'draft_stalled_on_question'));

  const clean = runDeterministicChecks({ action: 'answer', reply: 'Here is the draft.\n\n## Casual Security Officer', questions: [], args: {} }, { message: 'draft it', pending: null });
  assert.equal(clean.filter((issue) => issue.severity === 'block').length, 0);

  const rejected = runDeterministicChecks({ action: 'answer', reply: 'ok', questions: [], args: {}, planned_tool_rejected: 'run_sql' }, { message: 'x' });
  assert.ok(rejected.some((issue) => issue.code === 'tool_not_in_catalogue'));
});

test('autoRepairArgs nests stray query_records lookup terms and scrubReply strips leaks', () => {
  const repaired = autoRepairArgs('query_records', { query: 'find_org', name: 'LINZ' });
  assert.deepEqual(repaired, { args: { query: 'find_org', args: { name: 'LINZ' } }, repaired: true });
  assert.equal(autoRepairArgs('query_records', { query: 'find_org', args: { name: 'x' } }).repaired, false);
  assert.equal(scrubReply('[INTERNAL: hide] Site 123e4567-e89b-42d3-a456-426614174000 ok'), 'Site [record id withheld] ok');
});

test('parseCriticContent normalises the reviewer verdict', () => {
  assert.deepEqual(parseCriticContent('{"verdict":"repair","issues":[{"code":"Re-Ask","severity":"block","note":"fix"}],"summary":"s"}'), { verdict: 'repair', issues: [{ code: 'Re_Ask', severity: 'block', note: 'fix' }], summary: 's' });
  assert.equal(parseCriticContent('{"verdict":"repair","issues":[]}').verdict, 'pass');
  assert.equal(parseCriticContent('nope'), null);
});

test('gateway helpers detect reasoning models and rejected params', () => {
  assert.equal(isReasoningModel('gpt-5.4'), true);
  assert.equal(isReasoningModel('o3-mini'), true);
  assert.equal(isReasoningModel('gpt-4o-mini'), false);
  assert.equal(isReasoningModel('qwen2.5:7b', 'true'), true);
  assert.equal(paramsUnsupportedError('Unsupported parameter: max_tokens is not supported with this model'), true);
  assert.equal(paramsUnsupportedError('rate limited'), false);
});

function fakeFetch(handlers) {
  return async (url, init) => {
    const body = init && init.body ? JSON.parse(init.body) : null;
    for (const handler of handlers) {
      const result = await handler(String(url), body, init);
      if (result) return result;
    }
    throw new Error(`unhandled ${url}`);
  };
}

function jsonResponse(status, payload) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(payload), json: async () => payload };
}

function completion(content) {
  return jsonResponse(200, { choices: [{ message: { content } }], usage: {} });
}

test('gateway falls back from an unreachable GPU workstation to OpenAI and adapts rejected params', async () => {
  const calls = [];
  const gateway = createModelGateway({
    env: { OPENAI_API_KEY: 'k', OPENAI_MODEL: 'gpt-5.4-mini', OPENAI_PLAN_MODEL: 'gpt-5.4', GPU_WORKSTATION_URL: 'http://gpu:11435/v1', GPU_WORKSTATION_MODEL: 'qwen2.5:7b' },
    fetchImpl: fakeFetch([
      async (url) => (url.startsWith('http://gpu:11435/v1/models') ? (() => { throw new Error('ECONNREFUSED'); })() : null),
      async (url, body) => {
        if (!url.startsWith('https://api.openai.com/v1/chat/completions')) return null;
        calls.push(body);
        if (calls.length === 1 && body.max_completion_tokens) return jsonResponse(400, { error: { message: 'Unsupported parameter: max_completion_tokens' } });
        return completion('{"verdict":"pass","issues":[]}');
      },
    ]),
  });
  const result = await gateway.chatJson('verifier', [{ role: 'user', content: 'x' }], { maxTokens: 100 });
  assert.equal(result.provider, 'openai');
  assert.equal(result.model, 'gpt-5.4-mini');
  assert.equal(calls.length, 2);
  assert.ok('max_tokens' in calls[1]);
  assert.ok(result.attempts.some((attempt) => attempt.provider === 'gpu_workstation' && attempt.error === 'unhealthy_or_unreachable'));
});

test('planTurn repairs a re-ask after "yes to all" through the reviewer notes loop', async () => {
  let plannerCalls = 0;
  const gateway = {
    async chatJson(role, messages) {
      if (role === 'planner') {
        plannerCalls++;
        const prompt = messages[messages.length - 1].content;
        if (plannerCalls === 1) {
          assert.match(prompt, /IN-FLIGHT PLAN/);
          return { content: JSON.stringify({ action: 'ask', reply: 'Before I draft:', questions: [{ question: 'Do you want a 90-day trial clause included?', best_guess: 'yes' }] }), provider: 'openai', model: 'gpt-5.4', latency_ms: 5 };
        }
        assert.match(prompt, /REVIEWER NOTES/);
        assert.match(prompt, /blanket answer/);
        return { content: JSON.stringify({ action: 'answer', reply: '## Casual Security Officer — Job Description\n\n…\n\n## Individual Employment Agreement (Casual)\n\n…\n\nAssumptions: 90-day trial included [TO CONFIRM: eligibility].', confidence: 0.9, proposed_entities: { job_title: 'Casual Security Officer' } }), provider: 'openai', model: 'gpt-5.4', latency_ms: 5 };
      }
      if (role === 'verifier') return { content: JSON.stringify({ verdict: 'repair', issues: [{ code: 'continuity', severity: 'block', note: 'User said yes to all; draft now.' }], summary: 're-ask' }), provider: 'gpu_workstation', model: 'qwen2.5:7b', latency_ms: 3 };
      throw new Error(`unexpected role ${role}`);
    },
  };
  const result = await planTurn({
    message: 'yes to all',
    tools: TOOLS,
    pending: { kind: 'ask', questions: [{ question: 'Do you want a 90-day trial clause included?' }, { question: 'Own vehicle between sites?' }] },
  }, { gateway, env: {} });
  assert.equal(result.status, 200);
  assert.equal(result.body.action, 'answer');
  assert.match(result.body.reply, /Job Description/);
  assert.equal(result.body.verification.verdict, 'repair');
  assert.equal(result.body.verification.replanned, true);
  assert.ok(result.body.verification.issues.some((issue) => issue.code === 're_ask_after_blanket_answer'));
  assert.equal(result.body.verification.critic.provider, 'gpu_workstation');
  assert.equal(plannerCalls, 2);
  assert.deepEqual(result.body.proposed_entities, { job_title: 'Casual Security Officer' });
});

test('planTurn passes a clean tool decision without a critic call and returns the contract', async () => {
  const roles = [];
  const gateway = {
    async chatJson(role) {
      roles.push(role);
      return { content: JSON.stringify({ action: 'use_tool', tool: 'query_records', args: { query: 'find_org', name: 'LINZ' }, reply: 'Looking that up.' }), provider: 'openai', model: 'gpt-5.4', latency_ms: 4 };
    },
  };
  const result = await planTurn({ message: 'find LINZ', tools: TOOLS }, { gateway, env: {} });
  assert.deepEqual(roles, ['planner']);
  assert.equal(result.body.tool, 'query_records');
  assert.deepEqual(result.body.args, { query: 'find_org', args: { name: 'LINZ' } });
  assert.equal(result.body.route_selected, 'query_records');
  assert.equal(result.body.verification.verdict, 'pass');
  assert.equal(result.body.model, 'gpt-5.4');
});

test('planTurn works in-house first and escalates to OpenAI only when the local author is stuck', async () => {
  const { createModelGateway } = require('../services/fcm-api/src/bob/modelGateway');
  const real = createModelGateway({ env: { OPENAI_API_KEY: 'k', GPU_WORKSTATION_URL: 'http://laptop:11434/v1', GPU_WORKSTATION_MODEL: 'qwen2.5-coder:7b' } });
  assert.deepEqual(real.config.chains.planner, ['gpu_workstation', 'openai']);
  assert.deepEqual(real.chainAfter('planner', 'gpu_workstation'), ['openai']);
  assert.equal(real.chainAfter('planner', 'openai'), null, 'OpenAI is the last resort');
  assert.equal(real.providerKind('gpu_workstation'), 'ollama');

  // 1) The laptop model answers with prose instead of the JSON contract -> the turn goes to OpenAI.
  const calls = [];
  const gateway = {
    chainAfter: real.chainAfter,
    providerKind: real.providerKind,
    async chatJson(role, messages, options = {}) {
      calls.push({ role, chain: options.chain ?? null });
      if (role === 'planner' && !options.chain) return { content: 'Sure! Here is what I would do…', provider: 'gpu_workstation', model: 'qwen2.5-coder:7b', latency_ms: 30 };
      if (role === 'planner') return { content: JSON.stringify({ action: 'use_tool', tool: 'query_records', args: { query: 'find_org', name: 'LINZ' }, reply: 'Looking that up.' }), provider: 'openai', model: 'gpt-5.4', latency_ms: 40 };
      throw new Error(`unexpected role ${role}`);
    },
  };
  const result = await planTurn({ message: 'find LINZ', tools: TOOLS }, { gateway, env: {} });
  assert.equal(result.body.tool, 'query_records');
  assert.equal(result.body.provider, 'openai');
  assert.equal(result.body.verification.escalated, true);
  assert.deepEqual(result.body.passes.map((p) => [p.pass, p.provider]), [['author', 'gpu_workstation'], ['escalate', 'openai']]);
  assert.deepEqual(calls.map((c) => c.chain), [null, ['openai']]);

  // 2) The laptop model's draft is blocked by the verifier -> the repair goes to OpenAI, not back to the same model.
  const calls2 = [];
  const gateway2 = {
    chainAfter: real.chainAfter,
    providerKind: real.providerKind,
    async chatJson(role, messages, options = {}) {
      calls2.push({ role, chain: options.chain ?? null });
      if (role === 'planner' && !options.chain) return { content: JSON.stringify({ action: 'ask', reply: 'Before I draft:', questions: [{ question: 'Do you want a 90-day trial clause included?' }] }), provider: 'gpu_workstation', model: 'qwen2.5-coder:7b', latency_ms: 30 };
      if (role === 'planner') return { content: JSON.stringify({ action: 'answer', reply: '## Casual Security Officer — Job Description\n\n…', confidence: 0.9 }), provider: 'openai', model: 'gpt-5.4', latency_ms: 40 };
      if (role === 'verifier') return { content: JSON.stringify({ verdict: 'repair', issues: [], summary: 're-ask' }), provider: 'openai', model: 'gpt-5.4-mini', latency_ms: 3 };
      throw new Error(`unexpected role ${role}`);
    },
  };
  const repaired = await planTurn({ message: 'yes to all', tools: TOOLS, pending: { kind: 'ask', questions: [{ question: 'Do you want a 90-day trial clause included?' }] } }, { gateway: gateway2, env: {} });
  assert.equal(repaired.body.action, 'answer');
  assert.equal(repaired.body.verification.replanned, true);
  assert.equal(repaired.body.verification.escalated, true);
  const repairPass = repaired.body.passes.find((p) => p.pass === 'repair');
  assert.equal(repairPass.provider, 'openai');
  assert.equal(repairPass.escalated_from, 'gpu_workstation');
  assert.deepEqual(calls2.filter((c) => c.role === 'planner').map((c) => c.chain), [null, ['openai']]);
});

test('planTurn returns 502 with attempts when every provider fails', async () => {
  const gateway = { async chatJson() { const error = new Error('no model provider available'); error.attempts = [{ provider: 'openai', ok: false, error: 'http_500' }]; throw error; } };
  const result = await planTurn({ message: 'hi', tools: [] }, { gateway, env: {}, logger: { error() {} } });
  assert.equal(result.status, 502);
  assert.equal(result.body.route_selected, 'error');
  assert.equal(result.body.attempts[0].error, 'http_500');
});

test('gateway retries an empty or length-truncated planner completion once with low effort and a bigger budget', async () => {
  const bodies = [];
  const gateway = createModelGateway({
    env: { OPENAI_API_KEY: 'k', OPENAI_PLAN_MODEL: 'gpt-5.4', OPENAI_MODEL: 'gpt-5.4-mini' },
    fetchImpl: fakeFetch([
      async (url, body) => {
        if (!url.endsWith('/chat/completions')) return null;
        bodies.push(body);
        if (bodies.length === 1) return jsonResponse(200, { choices: [{ message: { content: '' }, finish_reason: 'length' }] });
        return jsonResponse(200, { choices: [{ message: { content: '{"action":"answer","reply":"draft"}' }, finish_reason: 'stop' }] });
      },
    ]),
  });
  const result = await gateway.chatJson('planner', [{ role: 'user', content: 'draft' }]);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].max_completion_tokens, 16000);
  assert.equal(bodies[0].reasoning_effort, 'medium');
  assert.equal(bodies[1].max_completion_tokens, 24000);
  assert.equal(bodies[1].reasoning_effort, 'low');
  assert.equal(result.truncated, false);
  assert.ok(result.attempts.some((attempt) => attempt.error === 'empty_completion_retrying_low_effort'));
});

test('a draft cut off mid-JSON is salvaged as the reply so the user never sees broken JSON', async () => {
  const { salvageReplyFromTruncatedJson } = require('../services/fcm-api/src/bob/planParse');
  assert.equal(salvageReplyFromTruncatedJson('{"action":"answer","reply":"## Job Description\\n\\nLine one \\"quoted\\" and'), '## Job Description\n\nLine one "quoted" and');
  assert.equal(salvageReplyFromTruncatedJson('no json here'), null);
  const gateway = { async chatJson() { return { content: '{"action":"answer","reply":"## Casual Security Officer\\n\\nSection 1', provider: 'openai', model: 'gpt-5.4', latency_ms: 5, truncated: true }; } };
  const result = await planTurn({ message: 'draft the agreement', tools: [] }, { gateway, env: { BOB_VERIFY_ENABLED: 'false' } });
  assert.equal(result.body.action, 'answer');
  assert.match(result.body.reply, /^## Casual Security Officer/);
  assert.match(result.body.reply, /Say "continue"/);
  assert.equal(result.body.observability.degraded, true);
});

test('author effort drops to low for drafting, synthesis, and tool-less passes', () => {
  const { authorEffort } = require('../services/fcm-api/src/bob/plan');
  assert.equal(authorEffort({ message: 'draft a job description', tools: TOOLS, history: [] }), 'low');
  assert.equal(authorEffort({ message: 'yes to all', tools: TOOLS, history: [{ role: 'user', content: 'write the employment agreement' }] }), 'low');
  assert.equal(authorEffort({ message: 'yes', tools: TOOLS, history: [], taskState: { subagent_results: [{ role: 'research' }] } }), 'low');
  assert.equal(authorEffort({ message: 'find LINZ', tools: [], history: [] }), 'low');
  assert.equal(authorEffort({ message: 'find LINZ', tools: TOOLS, history: [] }), undefined);
});

test('the verifier skips a provider that would answer with the author\'s exact identity (in-house critic stays a different model)', async () => {
  const calls = [];
  const gateway = createModelGateway({
    env: { OPENAI_API_KEY: 'k', OPENAI_MODEL: 'gpt-5.4-mini', OPENAI_PLAN_MODEL: 'gpt-5.4', GPU_WORKSTATION_URL: 'http://gpu:11435/v1', GPU_WORKSTATION_MODEL: 'qwen2.5:7b', GPU_WORKSTATION_PLAN_MODEL: 'qwen2.5-coder:7b', BOB_ROUTE_PLANNER: 'gpu_workstation,openai', BOB_ROUTE_VERIFIER: 'gpu_workstation,openai' },
    fetchImpl: fakeFetch([
      async (url) => (url.startsWith('http://gpu:11435/v1/models') ? jsonResponse(200, { data: [] }) : null),
      async (url, body) => {
        if (!/chat\/completions$/.test(url)) return null;
        calls.push({ url, model: body.model });
        return completion('{"verdict":"pass","issues":[]}');
      },
    ]),
  });
  // Distinct laptop models: planner on the coder model, critic on the general model — both in-house.
  const inHouse = await gateway.chatJson('verifier', [{ role: 'user', content: 'x' }], { maxTokens: 100, avoid: { provider: 'gpu_workstation', model: 'qwen2.5-coder:7b' } });
  assert.equal(inHouse.provider, 'gpu_workstation');
  assert.equal(inHouse.model, 'qwen2.5:7b');
  // Same identity as the author: the laptop is skipped and the critic escalates to OpenAI.
  const escalated = await gateway.chatJson('verifier', [{ role: 'user', content: 'x' }], { maxTokens: 100, avoid: { provider: 'gpu_workstation', model: 'qwen2.5:7b' } });
  assert.equal(escalated.provider, 'openai');
  assert.equal(escalated.attempts[0].error, 'same_identity_as_author');
});

test('a pending laptop command resumes on an affirmative with the stored command, verbatim', () => {
  const block = buildPendingBlock({ kind: 'laptop_command_pending', laptop_command: { command: 'Get-ChildItem C:\\Users\\Don\\Documents\\Contracts -Filter *.pdf', purpose: 'list the contract PDFs' } });
  assert.match(block, /IN-FLIGHT PLAN: on the previous turn you SHOWED the owner a PowerShell command/);
  assert.match(block, /Get-ChildItem C:\\\\Users\\\\Don\\\\Documents\\\\Contracts -Filter \*\.pdf/);
  assert.match(block, /tool=laptop_shell and args=\{ command, purpose \}/);
  assert.match(block, /If they decline, drop it/);
});

test('owner rulings and Bob\'s own notes get their own prompt block, not a truncated memory line', () => {
  const memoryContext = {
    organization_name: 'Iron Eagle',
    owner_rulings: ['Branch is not a client: A branch shares the parent org\'s agreements. ' + 'x'.repeat(700), '', 'Never guess a legal classification: ask for the bylaw.'],
    bob_own_notes: ['[correction] The owner prefers plain language over jargon.'],
  };
  const block = buildRulingsAndNotesBlock(memoryContext);
  assert.match(block, /OWNER RULINGS \(standing decisions by the platform owner/);
  assert.match(block, /  - Branch is not a client: A branch shares/);
  assert.match(block, /  - Never guess a legal classification/);
  assert.doesNotMatch(block, /x{501}/, 'each ruling is capped at 500 chars');
  assert.match(block, /YOUR OWN NOTES[\s\S]*  - \[correction\] The owner prefers plain language/);
  assert.match(block, /self_memory_write if that tool is available/);
  const generic = buildMemoryBlock(memoryContext);
  assert.match(generic, /organization_name: Iron Eagle/);
  assert.doesNotMatch(generic, /owner_rulings|bob_own_notes/, 'the generic block does not repeat them');
  assert.equal(buildRulingsAndNotesBlock({ organization_name: 'x' }), '');
  const prompt = buildPlannerPrompt({ message: 'hi', tools: [], memoryContext });
  assert.match(prompt, /OWNER RULINGS/);
});
