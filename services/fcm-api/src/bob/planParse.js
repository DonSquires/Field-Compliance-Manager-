'use strict';

/**
 * Tolerant parse of the planner's raw completion content. Reasoning models
 * sometimes wrap the JSON in a code fence or surround it with prose; a bare
 * JSON.parse would discard an otherwise-correct decision.
 */
function parsePlanContent(content) {
  const tryParse = (text) => {
    try {
      const value = JSON.parse(text);
      return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    } catch {
      return null;
    }
  };
  const raw = typeof content === 'string' ? content : '';
  const direct = tryParse(raw.trim());
  if (direct) return direct;
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) {
    const fenced = tryParse(fence[1].trim());
    if (fenced) return fenced;
  }
  const start = raw.indexOf('{');
  if (start !== -1) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < raw.length; i++) {
      const char = raw[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
      } else if (char === '"') {
        inString = true;
      } else if (char === '{') {
        depth++;
      } else if (char === '}') {
        depth--;
        if (depth === 0) return tryParse(raw.slice(start, i + 1));
      }
    }
  }
  return null;
}

/**
 * When a completion was cut off mid-JSON (finish_reason=length), recover the
 * partial "reply" string so the user gets the draft so far, never raw JSON.
 */
function salvageReplyFromTruncatedJson(content) {
  const raw = typeof content === 'string' ? content : '';
  const match = raw.match(/"reply"\s*:\s*"((?:[^"\\]|\\.)*)/);
  if (!match) return null;
  let text = match[1];
  try {
    text = JSON.parse(`"${text.replace(/\\$/, '')}"`);
  } catch {
    text = text.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return text.trim() ? text : null;
}

const canon = (value) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

function normalizeAction(raw) {
  const value = canon(raw);
  if (value === 'usetool' || value === 'tool') return 'use_tool';
  if (value === 'ask' || value === 'clarify' || value === 'clarifyingquestions') return 'ask';
  if (value === 'introspect') return 'introspect';
  if (value === 'delegate' || value === 'delegatesubagents' || value === 'subagents') return 'delegate';
  return 'answer';
}

function normalizeQuestions(raw) {
  return (Array.isArray(raw) ? raw : [])
    .map((q) => {
      if (typeof q === 'string') return { topic: '', question: q, best_guess: '', options: [] };
      const qq = q && typeof q === 'object' ? q : {};
      return {
        topic: qq.topic != null ? String(qq.topic) : '',
        question: qq.question != null ? String(qq.question) : '',
        best_guess: qq.best_guess != null ? String(qq.best_guess) : '',
        options: Array.isArray(qq.options) ? qq.options.map((o) => String(o)).filter(Boolean) : [],
      };
    })
    .filter((q) => q.question.trim());
}

const SUBAGENT_ROLES = new Set(['research', 'data', 'drafting', 'review']);
const MAX_SUBAGENTS = 3;

function normalizeSubagents(raw, delegableTools) {
  const allowed = new Set(delegableTools);
  return (Array.isArray(raw) ? raw : [])
    .map((s) => {
      const entry = s && typeof s === 'object' ? s : {};
      const role = SUBAGENT_ROLES.has(String(entry.role)) ? String(entry.role) : 'research';
      const goal = String(entry.goal ?? '').trim();
      const tools = (Array.isArray(entry.tools) ? entry.tools : []).map((t) => String(t)).filter((t) => allowed.has(t));
      return { role, goal, tools, inputs: entry.inputs && typeof entry.inputs === 'object' ? entry.inputs : {} };
    })
    .filter((s) => s.goal && s.tools.length)
    .slice(0, MAX_SUBAGENTS);
}

/**
 * Turn a raw model decision into the planner response contract. Only a tool
 * present in the supplied catalogue may be selected; an empty ask collapses to
 * answer so a turn can never stall.
 */
function normalizeDecision(decision, tools, { delegableTools = [] } = {}) {
  const d = decision && typeof decision === 'object' ? decision : {};
  const rawAction = normalizeAction(d.action);
  const allowed = new Set(tools.map((t) => t.tool));
  const requestedTool = rawAction === 'use_tool' && d.tool ? String(d.tool) : null;
  const matchedTool = requestedTool ? [...allowed].find((name) => canon(name) === canon(requestedTool)) ?? null : null;
  const questions = normalizeQuestions(d.questions);
  const subagents = rawAction === 'delegate' ? normalizeSubagents(d.subagents, delegableTools) : [];

  let action;
  if (matchedTool) action = 'use_tool';
  else if (rawAction === 'introspect') action = 'introspect';
  else if (rawAction === 'ask' && questions.length) action = 'ask';
  else if (rawAction === 'delegate' && subagents.length) action = 'delegate';
  else action = 'answer';

  const routeSelected = matchedTool ?? (action === 'ask' ? 'clarifying_questions' : action === 'introspect' ? 'introspect' : action === 'delegate' ? 'delegate' : 'answer');
  return {
    action,
    tool: matchedTool,
    args: d.args && typeof d.args === 'object' && !Array.isArray(d.args) ? d.args : {},
    reply: typeof d.reply === 'string' ? d.reply : '',
    questions: action === 'ask' ? questions.slice(0, 1) : [],
    subagents,
    proposed_entities: d.proposed_entities && typeof d.proposed_entities === 'object' && !Array.isArray(d.proposed_entities) ? d.proposed_entities : null,
    reasoning: typeof d.reasoning === 'string' ? d.reasoning : '',
    confidence: typeof d.confidence === 'number' && Number.isFinite(d.confidence) ? Math.max(0, Math.min(1, d.confidence)) : null,
    planned_tool_rejected: requestedTool && !matchedTool ? requestedTool : null,
    dropped_questions: action === 'ask' ? Math.max(0, questions.length - 1) : questions.length,
    requested_action: rawAction,
    route_selected: routeSelected,
  };
}

module.exports = { MAX_SUBAGENTS, SUBAGENT_ROLES, canon, normalizeAction, normalizeDecision, normalizeQuestions, normalizeSubagents, parsePlanContent, salvageReplyFromTruncatedJson };
