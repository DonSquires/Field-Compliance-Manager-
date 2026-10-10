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

test('planner is told which files are already in the session and never to ask for them again', () => {
  const prompt = buildPlannerPrompt({
    message: 'can you print it in this chat',
    tools: [{ tool: 'understand_documents', purpose: 'read session files' }],
    sessionAttachments: [{ name: 'RM capability 2024.pdf', kind: 'application/pdf' }, { name: 'Services list.docx', kind: null }],
  });
  assert.match(prompt, /FILES ALREADY IN THIS SESSION \(2/);
  assert.match(prompt, /RM capability 2024\.pdf/);
  assert.match(prompt, /select understand_documents/);
  assert.match(prompt, /NEVER ask the user to re-attach/);
  assert.match(prompt, /capability statements/);
  assert.doesNotMatch(buildPlannerPrompt({ message: 'hi', tools: TOOLS }), /FILES ALREADY IN THIS SESSION/);
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

  // Live failure 2026-09-29: Bob announced a capability statement draft and printed none of it.
  const announcedOnly = runDeterministicChecks({ action: 'answer', reply: 'Based on the documents and online research, here is a draft of the updated capability statement for R&M Security. I have included their services, company profile, and core capabilities. Please review.', questions: [], args: {} }, { message: 'padout the cabability statment for R&M security', pending: null });
  assert.ok(announcedOnly.some((issue) => issue.code === 'announced_draft_missing' && issue.severity === 'block'));

  const stalledCapability = runDeterministicChecks({ action: 'ask', reply: 'Before I start:', questions: [{ question: 'Which services?' }], args: {} }, { message: 'padout the cabability statment for R&M security' });
  assert.ok(stalledCapability.some((issue) => issue.code === 'draft_stalled_on_question'));

  const rejected = runDeterministicChecks({ action: 'answer', reply: 'ok', questions: [], args: {}, planned_tool_rejected: 'run_sql' }, { message: 'x' });
  assert.ok(rejected.some((issue) => issue.code === 'tool_not_in_catalogue'));
});

test('deterministic verifier blocks plate claims that exceed structured evidence authority', () => {
  const manualReview = {
    taskState: {
      last_tool_result: {
        files: [{
          structured_extraction: {
            document_kind: 'nzta_mvr_record',
            identifier_verification: {
              plate_number: { status: 'manual_review_required', value: null, candidates: [{ value: '11739' }] },
            },
          },
        }],
      },
    },
  };
  assert.ok(runDeterministicChecks(
    { action: 'answer', reply: 'Plate: 11739', questions: [], args: {} },
    manualReview,
  ).some((issue) => issue.code === 'identifier_evidence_mismatch' && issue.severity === 'block'));
  assert.equal(runDeterministicChecks(
    { action: 'answer', reply: 'Plate: [TO CONFIRM]', questions: [], args: {} },
    manualReview,
  ).some((issue) => issue.code === 'identifier_evidence_mismatch'), false);

  const verified = structuredClone(manualReview);
  verified.taskState.last_tool_result.files[0].structured_extraction.identifier_verification.plate_number = {
    status: 'verified_candidate',
    value: 'JJJ739',
    candidates: [{ value: 'JJJ739' }, { value: '11739' }],
  };
  assert.ok(runDeterministicChecks(
    { action: 'answer', reply: 'The record shows plate 11739.', questions: [], args: {} },
    verified,
  ).some((issue) => issue.code === 'identifier_evidence_mismatch'));
  assert.equal(runDeterministicChecks(
    { action: 'answer', reply: 'Plate: JJJ739', questions: [], args: {} },
    verified,
  ).some((issue) => issue.code === 'identifier_evidence_mismatch'), false);
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
  assert.ok(result.attempts.some((attempt) => attempt.provider === 'gpu_workstation' && /^unhealthy_or_unreachable/.test(attempt.error)));
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

test('the laptop provider accepts its URL with or without /v1 and health names why a probe failed', async () => {
  const { createModelGateway } = require('../services/fcm-api/src/bob/modelGateway');
  // The control plane shares GPU_WORKSTATION_URL without /v1; 2026-09-27 that made the gateway probe
  // http://laptop:11434/models (404) and report the in-house model unreachable while OpenAI was out of credit.
  const bare = createModelGateway({ env: { GPU_WORKSTATION_URL: 'http://laptop:11434', GPU_WORKSTATION_MODEL: 'qwen2.5:7b', OLLAMA_URL: 'http://ollama:11434/' } });
  assert.equal(bare.config.providers.gpu_workstation.baseUrl, 'http://laptop:11434/v1');
  assert.equal(bare.config.providers.vps_ollama.baseUrl, 'http://ollama:11434/v1');
  const withV1 = createModelGateway({ env: { GPU_WORKSTATION_URL: 'http://laptop:11434/v1/', GPU_WORKSTATION_MODEL: 'qwen2.5:7b' } });
  assert.equal(withV1.config.providers.gpu_workstation.baseUrl, 'http://laptop:11434/v1');

  const probed = [];
  const gateway = createModelGateway({
    env: { GPU_WORKSTATION_URL: 'http://laptop:11434', GPU_WORKSTATION_MODEL: 'qwen2.5:7b' },
    fetchImpl: async (url) => { probed.push(url); return { ok: false, status: 404 }; },
  });
  const status = await gateway.probe('gpu_workstation');
  assert.equal(status.healthy, false);
  assert.match(status.reason, /^probe_http_404 http:\/\/laptop:11434\/v1\/models$/);
  assert.deepEqual(probed, ['http://laptop:11434/v1/models']);
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

test('an empty OpenAI balance degrades a code request to the in-house planner and is named in health and in the failure reply (live 2026-09-27: every code request 502d)', async () => {
  const { createModelGateway } = require('../services/fcm-api/src/bob/modelGateway');
  let clock = 1_000_000;
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(url);
    if (url.startsWith('https://api.openai.com')) {
      if (url.endsWith('/models')) return new Response('{"data":[]}', { status: 200 });
      return new Response('{"error":{"message":"You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/.","type":"insufficient_quota"}}', { status: 429 });
    }
    if (url.endsWith('/models')) return new Response('{"models":[]}', { status: 200 });
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ action: 'answer', reply: 'laptop answered' }) } }], model: 'qwen2.5-coder:7b' }), { status: 200 });
  };
  const gateway = createModelGateway({ env: { OPENAI_API_KEY: 'k', GPU_WORKSTATION_URL: 'http://laptop:11434/v1', GPU_WORKSTATION_MODEL: 'qwen2.5-coder:7b' }, fetchImpl, now: () => clock, logger: { error() {}, warn() {} } });
  const result = await gateway.chatJson('planner', [{ role: 'user', content: 'hi' }], { chain: gateway.fastChain('planner') });
  assert.equal(result.provider, 'gpu_workstation', 'the laptop took the turn after OpenAI said no credits');
  assert.equal(result.attempts[0].error, 'insufficient_quota');
  const openai = (await gateway.status()).providers.find((p) => p.name === 'openai');
  assert.equal(openai.healthy, false);
  assert.equal(openai.reason, 'insufficient_quota', 'health names the cause');
  // Ten minutes, not one: the balance does not refill by itself.
  clock += 5 * 60000;
  assert.equal((await gateway.probe('openai')).healthy, false);
  clock += 6 * 60000;
  assert.equal((await gateway.probe('openai')).cached, false, 'probed again after the quota TTL');

  // Both tiers down: the planner's error tells the owner what to do instead of "API returned 502".
  const dead = { chainAfter: () => null, providerKind: () => 'openai', fastChain: () => ['openai'], async chatJson() { const e = new Error('no model provider available for role planner'); e.attempts = [{ provider: 'openai', error: 'insufficient_quota' }, { provider: 'gpu_workstation', error: 'unhealthy_or_unreachable' }]; throw e; } };
  const out = await planTurn({ message: 'fix loadHistory please', tools: [...TOOLS, { tool: 'repo_search' }, { tool: 'create_builder_job' }], verify: false }, { gateway: dead, env: {}, logger: { error() {} } });
  assert.equal(out.status, 502);
  assert.equal(out.body.quota_exhausted, true);
  assert.match(out.body.error, /OpenAI\) has no credits left/);
  assert.match(out.body.error, /platform\.openai\.com\/settings\/organization\/billing/);
});

test('a tight deadline skips the in-house planner and shortens the turn; the prompt tells the model how long is left', async () => {
  const { createModelGateway } = require('../services/fcm-api/src/bob/modelGateway');
  const { readBody } = require('../services/fcm-api/src/bob/plan');
  const real = createModelGateway({ env: { OPENAI_API_KEY: 'k', GPU_WORKSTATION_URL: 'http://laptop:11434/v1', GPU_WORKSTATION_MODEL: 'qwen2.5-coder:7b' } });
  assert.deepEqual(real.fastChain('planner'), ['openai', 'gpu_workstation'], 'strong tier first, in-house kept as the fallback for an empty OpenAI balance');
  assert.equal(createModelGateway({ env: { OPENAI_API_KEY: 'k', BOB_ROUTE_PLANNER: 'openai' } }).fastChain('planner'), null, 'no in-house tier to skip');
  assert.equal(readBody({ deadline_ms: '30000' }).deadlineMs, 30000);
  assert.equal(readBody({ deadline_ms: -5 }).deadlineMs, null);
  assert.equal(readBody({}).deadlineMs, null);

  const calls = [];
  const gateway = {
    chainAfter: real.chainAfter,
    providerKind: real.providerKind,
    fastChain: real.fastChain,
    async chatJson(role, messages, options = {}) {
      calls.push({ role, chain: options.chain ?? null, timeoutMs: options.timeoutMs });
      return { content: JSON.stringify({ action: 'answer', reply: 'That script does not exist in the build.', confidence: 0.9 }), provider: 'openai', model: 'gpt-5.4', latency_ms: 40 };
    },
  };
  const result = await planTurn({ message: 'fix scripts/ghost.mjs', tools: TOOLS, verify: false, deadline_ms: 30000, task_state: { goal: 'fix scripts/ghost.mjs', steps_taken: [{ tool: 'repo_search', outcome: 'ok', result_summary: 'status: not_found' }], time_left_s: 30 } }, { gateway, env: {} });
  assert.equal(result.body.action, 'answer');
  assert.deepEqual(calls[0].chain, ['openai', 'gpu_workstation'], 'no time for the laptop model: straight to the fast tier (laptop only as fallback)');
  assert.ok(calls[0].timeoutMs <= 25000, `turn budget shrank to the deadline (got ${calls[0].timeoutMs})`);

  // A comfortable deadline keeps in-house first.
  const calls2 = [];
  await planTurn({ message: 'hi', tools: TOOLS, verify: false, deadline_ms: 90000 }, { gateway: { ...gateway, async chatJson(role, messages, options = {}) { calls2.push(options.chain ?? null); return { content: JSON.stringify({ action: 'answer', reply: 'Hello.' }), provider: 'gpu_workstation', model: 'q', latency_ms: 5 }; } }, env: {} });
  assert.deepEqual(calls2, [null]);

  const prompt = buildPlannerPrompt({ message: 'x', tools: [], taskState: { goal: 'g', steps_taken: [], time_left_s: 27 } });
  assert.match(prompt, /TIME LEFT IN THIS TURN: about 27 s\. If the results below already answer the question \(a not_found IS an answer\), select action=answer NOW/);
});

test('a code request answered with a procedure and no repository lookup is blocked for repair', () => {
  const tools = [{ tool: 'repo_search' }, { tool: 'query_records' }];
  const procedure = { action: 'answer', reply: 'The error indicates a TypeError. To fix it I will follow these steps:\n1. Identify the error\n2. Fix the error\n3. Add a test\nWhat do you think about this approach?' };
  const issues = runDeterministicChecks(procedure, { message: 'Bob, scripts/rotate-evidence-keys.mjs crashes on startup with a TypeError. Please fix it and add a test.', tools });
  assert.ok(issues.some((i) => i.code === 'code_answer_without_evidence' && i.severity === 'block'), JSON.stringify(issues));
  // A real answer after a repository lookup passes.
  const grounded = { action: 'answer', reply: 'There is no scripts/rotate-evidence-keys.mjs in the build (searched main; not found). Which script did you mean?' };
  assert.equal(runDeterministicChecks(grounded, { message: 'fix scripts/rotate-evidence-keys.mjs crash', tools, taskState: { steps_taken: [{ tool: 'repo_search', outcome: 'ok' }] } }).some((i) => i.code === 'code_answer_without_evidence'), false);
  // Not a code request -> the rule stays out of the way.
  assert.equal(runDeterministicChecks({ action: 'answer', reply: 'I will draft the letter first, what do you think?' }, { message: 'help me reply to the council', tools }).some((i) => i.code === 'code_answer_without_evidence'), false);
  // No repo tool for this user (not admiral) -> no demand for evidence he cannot gather.
  assert.equal(runDeterministicChecks(procedure, { message: 'fix scripts/x.mjs crash', tools: [{ tool: 'query_records' }] }).some((i) => i.code === 'code_answer_without_evidence'), false);
});

test('a bug report that names code identifiers is a code request, and a prose promise of engineering work is blocked (live 2026-09-27: the 7B planner narrated "I will update the loadHistory logic" and opened nothing)', async () => {
  const { isCodeRequest } = require('../services/fcm-api/src/bob/verify');
  const report = "Bob, the confirmation does not work: persist() writes the user row and the assistant row with the identical created_at, so loadHistory can see the USER row as newest. Fix loadHistory so the proposal counts when it is the newest ASSISTANT row, and add a test. Go ahead.";
  assert.equal(isCodeRequest(report), true, 'loadHistory / created_at / persist() are code identifiers');
  assert.equal(isCodeRequest('Fix the failing roster export test please'), true);
  assert.equal(isCodeRequest('please look at PR #10 again'), true);
  for (const plain of ['who is rostered at Nelson tonight?', 'help me reply to the council about the camping bylaw', 'Please draft a job description for a Site Supervisor', 'What does the parking module do?', 'How many vehicles were scanned at Wakefield Quay yesterday?']) {
    assert.equal(isCodeRequest(plain), false, plain);
  }
  // Identifiers are case-sensitive: an ordinary capitalised word is not camelCase.
  assert.equal(isCodeRequest('Tahunanui Beach noise complaints'), false);

  const tools = [{ tool: 'repo_search' }, { tool: 'create_builder_job' }];
  const narration = { action: 'answer', reply: 'I have identified the issue. To fix this, I will update the loadHistory logic to identify the newest assistant proposal. I will also add a test case. Once the fix is implemented, I will propose the changes for review.' };
  const blocked = runDeterministicChecks(narration, { message: report, tools, taskState: { steps_taken: [{ tool: 'repo_search', outcome: 'ok' }] } });
  assert.ok(blocked.some((i) => i.code === 'promised_work' && i.severity === 'block'), JSON.stringify(blocked));
  // Honest inability, a real job, a non-admiral user, or a non-code drafting promise are not blocked by this rule.
  assert.equal(runDeterministicChecks({ action: 'answer', reply: 'I could not open a job: the Builder is paused. Nothing was changed.' }, { message: report, tools }).some((i) => i.code === 'promised_work'), false);
  assert.equal(runDeterministicChecks({ action: 'use_tool', tool: 'create_builder_job', args: { title: 't', task_description: 'd' } }, { message: report, tools }).some((i) => i.code === 'promised_work'), false);
  assert.equal(runDeterministicChecks(narration, { message: report, tools: [{ tool: 'query_records' }] }).some((i) => i.code === 'promised_work'), false);
  assert.equal(runDeterministicChecks({ action: 'answer', reply: 'I will write the letter using the council template.' }, { message: 'help me reply to the council', tools }).some((i) => i.code === 'promised_work'), false);
  // Routing: the identifier-only bug report goes to the strong tier like a path-naming one.
  const { createModelGateway } = require('../services/fcm-api/src/bob/modelGateway');
  const real = createModelGateway({ env: { OPENAI_API_KEY: 'k', GPU_WORKSTATION_URL: 'http://laptop:11434/v1', GPU_WORKSTATION_MODEL: 'qwen2.5-coder:7b' } });
  const chains = [];
  const gateway = { chainAfter: real.chainAfter, providerKind: real.providerKind, fastChain: real.fastChain, async chatJson(role, messages, options = {}) { chains.push(options.chain ?? null); return { content: JSON.stringify({ action: 'answer', reply: 'ok' }), provider: 'openai', model: 'm' }; } };
  await planTurn({ message: report, tools: [...TOOLS, ...tools], verify: false }, { gateway, env: {} });
  assert.deepEqual(chains, [['openai', 'gpu_workstation']]);
});

test('owner-level code requests go straight to the strong planner tier; ordinary requests stay in-house first', async () => {
  const { createModelGateway } = require('../services/fcm-api/src/bob/modelGateway');
  const real = createModelGateway({ env: { OPENAI_API_KEY: 'k', GPU_WORKSTATION_URL: 'http://laptop:11434/v1', GPU_WORKSTATION_MODEL: 'qwen2.5-coder:7b' } });
  const chains = [];
  const gateway = {
    chainAfter: real.chainAfter, providerKind: real.providerKind, fastChain: real.fastChain,
    async chatJson(role, messages, options = {}) { chains.push(options.chain ?? null); return { content: JSON.stringify({ action: 'answer', reply: 'ok' }), provider: options.chain ? 'openai' : 'gpu_workstation', model: 'm', latency_ms: 5 }; },
  };
  const ownerTools = [...TOOLS, { tool: 'repo_search' }, { tool: 'create_builder_job' }];
  await planTurn({ message: 'Bob, apps/mobile/src/components/OfficerVehicleLookup.tsx shows raw errors to officers; fix it and add a test', tools: ownerTools, verify: false }, { gateway, env: {} });
  await planTurn({ message: 'Bob, apps/mobile/src/components/OfficerVehicleLookup.tsx shows raw errors', tools: TOOLS, verify: false }, { gateway, env: {} });
  await planTurn({ message: 'who is rostered at Nelson tonight?', tools: ownerTools, verify: false }, { gateway, env: {} });
  await planTurn({ message: 'fix scripts/x.mjs crash', tools: ownerTools, verify: false }, { gateway, env: { BOB_PLAN_CODE_REQUESTS_IN_HOUSE: 'true' } });
  assert.deepEqual(chains, [['openai', 'gpu_workstation'], null, null, null], 'only the owner-level code request goes strong-tier first');
  // A "we should…" restatement of a code request with no lookup is blocked too.
  const issues = runDeterministicChecks({ action: 'answer', reply: 'The catch block shows the raw message. To improve security, we should display a plain message and log the cause. If the app has a test runner, we should add a unit test.' }, { message: 'Bob, in apps/mobile/src/components/OfficerVehicleLookup.tsx the catch shows cause.message to officers; fix it and add a test', tools: ownerTools });
  assert.ok(issues.some((i) => i.code === 'code_answer_without_evidence'));
});
