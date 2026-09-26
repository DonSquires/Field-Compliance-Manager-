'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildPendingBlock, buildPlannerPrompt, buildPlannerMessages, buildTaskStateBlock, buildMemoryBlock, sliceWithDisclosure } = require('../services/fcm-api/src/bob/planPrompt');
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
  const reAsk = runDeterministicChecks({ action: 'ask', reply: 'Great.', questions: [{ question: 'Do you want a 90 day trial clause included?' }], args: {} }, { message: 'yes to all', pending });
  assert.ok(reAsk.some((issue) => issue.code === 're_ask_after_blanket_answer' && issue.severity === 'block'));

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
