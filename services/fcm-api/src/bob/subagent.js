'use strict';

const { parsePlanContent, canon } = require('./planParse');
const { sliceWithDisclosure } = require('./planPrompt');

/**
 * Bob's working subagents. Each call is ONE step of a focused, bounded agent
 * loop that the conductor drives: the subagent sees its goal, the read-only
 * tools Bob granted it, and the results so far, then returns either the next
 * tool call or its findings. Subagents never file proposals and never see
 * tools outside the caller's envelope (the conductor intersects the sets).
 */

const ROLE_BRIEFS = {
  research: 'You are Bob\'s RESEARCH subagent. Gather current, source-grounded evidence: official New Zealand sources first (legislation.govt.nz, employment.govt.nz, ird.govt.nz, worksafe.govt.nz, business.govt.nz, the PSPLA for security licensing), then platform knowledge cards, then reputable sector sources. Record for every fact: the source URL/title, what it says, and how confident you are. Never research a named private individual.',
  data: 'You are Bob\'s DATA subagent. Answer the goal from the platform\'s own records using the lookup tools you were given (query_records first; sql_read only for aggregates no lookup can answer). Resolve names to records before drawing conclusions, iterate per organisation when a task spans several, and report counts, names, and gaps — never raw identifiers.',
  drafting: 'You are Bob\'s DRAFTING subagent. Produce the requested document section using the facts and research supplied. Use New Zealand conventions, mark unknowns as [TO CONFIRM: what], and keep an Assumptions list. Do not invent facts, laws, or rates.',
  review: 'You are Bob\'s REVIEW subagent. Check the supplied draft or plan against the sources and records you can reach: flag unsupported claims, contradictions with the source documents, missing mandatory elements, and identifier or privacy leaks. Recommend; never rewrite silently.',
};

function readSubagentBody(body) {
  const b = body && typeof body === 'object' ? body : {};
  const tools = Array.isArray(b.tools) ? b.tools.filter((t) => t && typeof t.tool === 'string') : [];
  return {
    role: Object.prototype.hasOwnProperty.call(ROLE_BRIEFS, String(b.role)) ? String(b.role) : 'research',
    goal: String(b.goal ?? '').trim(),
    inputs: b.inputs && typeof b.inputs === 'object' ? b.inputs : {},
    tools,
    stepsTaken: Array.isArray(b.steps_taken) ? b.steps_taken : [],
    maxSteps: Math.max(1, Math.min(8, Number(b.max_steps) || 4)),
    userMessage: String(b.user_message ?? '').slice(0, 4000),
    knowledge: typeof b.knowledge === 'string' ? b.knowledge.slice(0, 20000) : '',
    platformContext: typeof b.platform_context === 'string' ? b.platform_context : '',
  };
}

function buildSubagentMessages(input) {
  const toolList = input.tools.map((t) => `- ${t.tool}: ${t.purpose}`).join('\n') || '(no tools)';
  const steps = input.stepsTaken.map((s, i) => `  ${i + 1}. ${String(s.tool)} ${s.args ? JSON.stringify(s.args).slice(0, 400) : ''} -> ${String(s.outcome ?? 'ok')}\n     ${sliceWithDisclosure(s.result_summary, 12000, `step ${i + 1} result`)}`).join('\n');
  const remaining = input.maxSteps - input.stepsTaken.length;
  return [
    { role: 'system', content: `${ROLE_BRIEFS[input.role]}\n${input.platformContext ? `\n${input.platformContext}\n` : ''}\nYou work in bounded steps. Each reply is ONE JSON object: either the next single tool call, or "done" with your findings. Findings must be complete, specific, and cite sources (title + URL) or record names; state plainly what you could NOT find. Never output identifiers, internal markers, or tool names inside findings. Return ONLY JSON.` },
    {
      role: 'user',
      content: [
        `GOAL: ${input.goal}`,
        Object.keys(input.inputs).length ? `INPUTS FROM BOB: ${JSON.stringify(input.inputs).slice(0, 4000)}` : '',
        input.userMessage ? `THE USER ORIGINALLY ASKED BOB: ${input.userMessage}` : '',
        input.knowledge ? `PLATFORM KNOWLEDGE ALREADY AVAILABLE:\n${input.knowledge}` : '',
        `TOOLS YOU MAY USE (read-only; each call is one step):\n${toolList}`,
        'Tool call shapes: web_research args={ "query": string, "urls"?: [string] }; retrieve_knowledge args={ "query": string }; query_records args={ "query": "find_org"|"list_sites"|"list_routes"|"list_zones"|"find_user"|"list_orgs", "args": { "name"?: string, "org_id"?: string } }; sql_read args={ "sql": "SELECT …" }; schema_inspect args={ "table"?: string }; repo_search args={ "query": string } or { "path": string }; read_issues args={ "iid"?: number }.',
        steps ? `STEPS COMPLETED SO FAR:\n${steps}` : 'No steps taken yet.',
        `You have ${remaining} step(s) left. ${remaining <= 1 ? 'You MUST return "done" now with the best findings you have.' : 'Do not repeat a call you already made with the same arguments.'}`,
        '',
        'Return ONLY one of:',
        '{ "action": "use_tool", "tool": string, "args": object, "why": string }',
        '{ "action": "done", "findings": string, "sources": [string], "confidence": number, "gaps": [string] }',
      ].filter(Boolean).join('\n'),
    },
  ];
}

function normalizeSubagentDecision(raw, tools, input) {
  const d = raw && typeof raw === 'object' ? raw : {};
  const allowed = new Set(tools.map((t) => t.tool));
  const requested = d.tool ? String(d.tool) : null;
  const tool = requested ? [...allowed].find((name) => canon(name) === canon(requested)) ?? null : null;
  const action = canon(d.action) === 'usetool' && tool && input.stepsTaken.length < input.maxSteps ? 'use_tool' : 'done';
  if (action === 'use_tool') {
    return { action, tool, args: d.args && typeof d.args === 'object' ? d.args : {}, why: String(d.why ?? '').slice(0, 300) };
  }
  const fallbackFindings = input.stepsTaken.length
    ? `Findings could not be finalised by the model; raw step results follow.\n${input.stepsTaken.map((s, i) => `${i + 1}. ${s.tool}: ${String(s.result_summary || '').slice(0, 3000)}`).join('\n')}`
    : 'No findings: the subagent could not complete any step.';
  return {
    action: 'done',
    findings: typeof d.findings === 'string' && d.findings.trim() ? d.findings : fallbackFindings,
    sources: (Array.isArray(d.sources) ? d.sources : []).map((s) => String(s)).filter(Boolean).slice(0, 12),
    confidence: typeof d.confidence === 'number' && Number.isFinite(d.confidence) ? Math.max(0, Math.min(1, d.confidence)) : null,
    gaps: (Array.isArray(d.gaps) ? d.gaps : []).map((g) => String(g)).filter(Boolean).slice(0, 8),
    tool_rejected: requested && !tool ? requested : null,
  };
}

async function subagentStep(body, { gateway, now = Date.now, logger = console } = {}) {
  const input = readSubagentBody(body);
  if (!input.goal) return { status: 400, body: { ok: false, error: 'goal is required' } };
  const started = now();
  try {
    const completion = await gateway.chatJson('subagent', buildSubagentMessages(input), { maxTokens: 2500, timeoutMs: 45000, reasoningEffort: 'low', temperature: 0.2 });
    const decision = normalizeSubagentDecision(parsePlanContent(completion.content), input.tools, input);
    return { status: 200, body: { ok: true, role: input.role, ...decision, provider: completion.provider, model: completion.model, latency_ms: now() - started } };
  } catch (error) {
    if (logger && logger.error) logger.error(`[bob/subagent] unavailable: ${String(error && error.message || error)}`);
    return { status: 502, body: { ok: false, error: 'Subagent unavailable', role: input.role, latency_ms: now() - started } };
  }
}

module.exports = { ROLE_BRIEFS, buildSubagentMessages, normalizeSubagentDecision, readSubagentBody, subagentStep };
