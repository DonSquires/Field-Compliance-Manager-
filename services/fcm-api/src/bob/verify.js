'use strict';

/**
 * Bob's verifying subagent (chat lane). Two layers:
 *   1. deterministic checks — fast, no model, catch the mechanical failures
 *      (internal markers, identifier leaks, questionnaires, re-asking answered
 *      questions, false completion claims, malformed tool args);
 *   2. an independent critic on a DIFFERENT model identity from the author,
 *      recommend-only (BOB_DOCTRINE §9): it reports issues, the planner repairs.
 */

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const INTERNAL_MARKER_RE = /\[(INTERNAL|SYSTEM|DEBUG|ERROR|TOOL|QUERY|TRUNCATED)\b/i;
const SQL_ERROR_RE = /(column\s+"?[\w.]+"?\s+does not exist|relation\s+"?[\w.]+"?\s+does not exist|syntax error at or near|PGRST\d{3}|\b42P01\b|\b42703\b|permission denied for (table|relation))/i;
const FALSE_COMPLETION_RE = /\b(I have|I've|I just|has been|have been|was|were) (now )?(created|filed|updated|deleted|deployed|merged|approved|saved|written|applied|submitted|executed|imported|rostered|invoiced|paid)\b/i;
const BANNED_FILLER_RE = /\b(certainly|of course|happy to help|great question|absolutely|as an ai( language model)?|i am programmed to|leverage|streamline|robust)\b/gi;
const BLANKET_AFFIRMATIVE_RE = /^\s*(yes|yep|yeah|ok|okay|sure|correct|confirmed|agreed|go ahead|proceed|do it|all good|sounds good|yes to all|yes to everything|all of (them|the above)|use your (defaults|best guess(es)?)|go with your (defaults|best guess(es)?)|you decide|whatever you recommend|as you suggest(ed)?)[\s.!]*$/i;
const DRAFT_REQUEST_RE = /\b(draft|write|create|prepare|produce|generate|put together)\b[\s\S]{0,80}\b(job description|position description|advert(isement)?|job ad|seek ad|agreement|contract|letter|policy|sop|procedure|report|checklist|proposal|email|memo|site instruction|brief|synopsis|summary)\b/i;

function countQuestionLines(text) {
  return String(text || '').split('\n').filter((line) => /^\s*(?:\d+[.)]|[-*•])\s+.*\?\s*$/.test(line)).length;
}

function tokenSet(text) {
  return new Set(String(text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((t) => t.length > 2));
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared++;
  return shared / (a.size + b.size - shared);
}

function normalizeQuestionText(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Mechanical fix for the one arg-shape mistake the planner keeps making:
 * query_records lookup terms placed beside "query" instead of inside args.args.
 */
function autoRepairArgs(tool, args) {
  if (tool !== 'query_records' || !args || typeof args !== 'object') return { args, repaired: false };
  const inner = args.args && typeof args.args === 'object' ? { ...args.args } : {};
  let repaired = false;
  for (const key of ['name', 'org_id', 'organization_id', 'email', 'code', 'id', 'limit']) {
    if (key in args && !(key in inner) && key !== 'query') {
      inner[key] = args[key];
      repaired = true;
    }
  }
  if (!repaired) return { args, repaired: false };
  const next = { query: args.query, args: inner };
  for (const key of Object.keys(args)) if (!['name', 'org_id', 'organization_id', 'email', 'code', 'id', 'limit', 'args', 'query'].includes(key)) next[key] = args[key];
  return { args: next, repaired: true };
}

/** Deterministic checks. Returns issues [{ code, severity: 'block'|'warn'|'style', note }]. */
function runDeterministicChecks(decision, input) {
  const issues = [];
  const reply = String(decision.reply ?? '');
  const message = String(input.message ?? '');
  const pending = input.pending && typeof input.pending === 'object' ? input.pending : null;
  const userFacing = decision.action === 'answer' || decision.action === 'ask';

  if (userFacing && !reply.trim() && !(decision.action === 'ask' && decision.questions.length)) {
    issues.push({ code: 'empty_reply', severity: 'block', note: 'The reply was empty. Give the user the actual answer or deliverable.' });
  }
  if (INTERNAL_MARKER_RE.test(reply)) {
    issues.push({ code: 'internal_marker_leak', severity: 'block', note: 'The reply contains an internal bracketed marker ([INTERNAL/[SYSTEM/[TOOL/[TRUNCATED…). Reason over that content and write a plain-language reply that never includes such markers.' });
  }
  const uuidMatches = reply.match(UUID_RE) || [];
  if (uuidMatches.length) {
    issues.push({ code: 'uuid_leak', severity: 'block', note: `The reply shows ${uuidMatches.length} raw identifier(s). Refer to records by name, role, or organisation only — carry ids internally.` });
  }
  if (SQL_ERROR_RE.test(reply)) {
    issues.push({ code: 'sql_error_leak', severity: 'block', note: 'The reply exposes a database error message. Classify the error internally and either self-correct the lookup or ask one plain question.' });
  }
  if (userFacing) {
    const questionLines = countQuestionLines(reply);
    if (questionLines >= 3 || (decision.action === 'ask' && questionLines >= 2)) {
      issues.push({ code: 'questionnaire', severity: 'block', note: `The reply lists ${questionLines} questions. Ask at most ONE question (with your best guess) and proceed with sensible defaults for the rest — or, for a drafting request, draft now with [TO CONFIRM] markers.` });
    }
    if (pending && pending.kind === 'ask' && Array.isArray(pending.questions) && pending.questions.length) {
      const blanket = BLANKET_AFFIRMATIVE_RE.test(message) || /\b(yes|ok|okay|confirm|confirmed|agreed|correct|go ahead|proceed|do it)\b/i.test(message) && /\b(all|everything|every one|each|the above)\b/i.test(message);
      const askedAgain = decision.action === 'ask' && decision.questions.some((q) => pending.questions.some((p) => jaccard(tokenSet(normalizeQuestionText(q.question)), tokenSet(normalizeQuestionText(p && p.question))) >= 0.45));
      if (blanket && (decision.action === 'ask' || questionLines >= 1)) {
        issues.push({ code: 're_ask_after_blanket_answer', severity: 'block', note: `The user answered your ${pending.questions.length} earlier question(s) with a blanket answer ("${message.trim().slice(0, 40)}"). Treat every one as answered with your best guess and DO THE WORK now; do not ask any of them again.` });
      } else if (askedAgain) {
        issues.push({ code: 're_ask_answered_question', severity: 'block', note: 'You re-asked a question from the previous turn that the user has just answered. Use their answer and take the next concrete step.' });
      }
    }
    if (decision.action === 'answer' && !decision.tool && FALSE_COMPLETION_RE.test(reply) && !/\b(not|nothing|no)\b[^.]{0,40}\b(created|filed|updated|deleted|deployed|merged|approved|saved|written|applied|submitted|executed)\b/i.test(reply)) {
      issues.push({ code: 'false_completion_claim', severity: 'warn', note: 'The reply appears to claim that a write/approval/deployment has already happened, but no tool ran this turn. Never claim a write, approval, or deployment occurred; describe what WILL happen after approval.' });
    }
    if (message.length > 200 && jaccard(tokenSet(message), tokenSet(reply)) > 0.8) {
      issues.push({ code: 'echo', severity: 'warn', note: 'The reply mostly restates the user\'s own message. Interpret it and take the next step instead of echoing.' });
    }
    if (decision.action === 'ask' && DRAFT_REQUEST_RE.test(message)) {
      issues.push({ code: 'draft_stalled_on_question', severity: 'warn', note: 'This is a drafting request. Drafting discipline: draft now using sensible NZ defaults with [TO CONFIRM: …] markers and an Assumptions list; ask ONE question only if the draft genuinely cannot be started.' });
    }
    const filler = reply.match(BANNED_FILLER_RE) || [];
    if (filler.length) {
      issues.push({ code: 'banned_filler', severity: 'style', note: `Remove banned filler phrasing (${[...new Set(filler.map((f) => f.toLowerCase()))].slice(0, 4).join(', ')}); speak plainly in Bob\'s voice.` });
    }
  }
  if (decision.action === 'use_tool' && decision.tool === 'query_records') {
    const args = decision.args || {};
    if (!args.query) {
      issues.push({ code: 'query_records_missing_query', severity: 'block', note: 'query_records needs args.query (find_org, list_sites, list_routes, list_zones, find_user, …) with the search terms nested in args.args.' });
    }
  }
  if (decision.planned_tool_rejected) {
    issues.push({ code: 'tool_not_in_catalogue', severity: 'block', note: `You selected "${decision.planned_tool_rejected}", which is not in the tool catalogue for this user. Choose a listed tool, or answer directly and state plainly which step you cannot action.` });
  }
  return issues;
}

function shortHistory(history, limit = 2) {
  return (Array.isArray(history) ? history : []).slice(-limit).map((h) => `${h.role}: ${String(h.content || '').slice(0, 600)}`).join('\n');
}

function buildCriticMessages(decision, input, deterministicIssues) {
  const pending = input.pending && typeof input.pending === 'object' ? input.pending : null;
  const pendingText = pending && pending.kind === 'ask' && Array.isArray(pending.questions)
    ? `Bob asked these on the PREVIOUS turn and the user's message below is the answer:\n${pending.questions.map((q, i) => `  ${i + 1}. ${String(q && q.question)}${q && q.best_guess ? ` (best guess: ${q.best_guess})` : ''}`).join('\n')}`
    : pending && pending.kind
      ? `In-flight plan from the previous turn: ${pending.kind}${pending.suggested_action ? ` — ${pending.suggested_action}` : ''}`
      : 'No in-flight plan from the previous turn.';
  return [
    {
      role: 'system',
      content: 'You are the independent reviewer for Bob, an operational AI assistant inside a New Zealand field-compliance SaaS platform. You do NOT rewrite Bob\'s reply; you judge a DRAFT reply before it reaches the user and report concrete, fixable problems. Be strict about the checklist and lenient about style. Return ONLY JSON.',
    },
    {
      role: 'user',
      content: [
        'CHECKLIST (a failure on any item means verdict="repair"):',
        '1. Continuity: does the draft re-ask something the user already answered (including a blanket "yes to all" / "use your defaults")? Does it ignore an in-flight plan the user just approved?',
        '2. One-question rule: does the draft ask more than one question, or present a questionnaire instead of doing the work?',
        '3. Drafting discipline: if the user asked for a document (job description, ad, agreement, letter, policy, report…), does the draft actually deliver it (with [TO CONFIRM] markers for unknowns) rather than stalling? Delivering the FIRST complete document with a one-line offer of the next one is acceptable when several were requested; a summary of what Bob would write is not.',
        '4. Truthfulness: does it claim a write, approval, filing, deployment, or identity match happened when no tool ran? Does it state a specific NZ legal rule, rate, or date as fact without the supplied knowledge/research supporting it? (Unsupported specifics should be hedged or marked [TO CONFIRM].)',
        '5. Leakage: raw identifiers, internal bracketed markers, tool/function names, database or system error text.',
        '6. Responsiveness: does it answer what was actually asked, in the requested form (shorter/longer/format), without echoing the user\'s text back?',
        '7. Safety and scope: personal-data lookups on named private individuals, or cross-tenant identifiers echoed back when a lookup found nothing.',
        '',
        `CONTEXT\n${pendingText}`,
        shortHistory(input.history) ? `Recent conversation:\n${shortHistory(input.history)}` : '',
        `User's current message: ${String(input.message || '').slice(0, 2000)}`,
        `Tool ran this turn: ${decision.tool ? decision.tool : 'none'}`,
        deterministicIssues.length ? `Mechanical checks already flagged: ${deterministicIssues.map((i) => i.code).join(', ')}` : '',
        '',
        `BOB'S DRAFT DECISION\naction: ${decision.action}\n${decision.action === 'ask' ? `question: ${decision.questions.map((q) => q.question).join(' | ')}\n` : ''}reply:\n${String(decision.reply || '').slice(0, 9000)}`,
        '',
        'Return ONLY: { "verdict": "pass" | "repair", "issues": [ { "code": string, "severity": "block" | "warn", "note": string } ], "summary": string }',
        'Each note must tell Bob exactly what to change. If nothing is wrong, verdict="pass" and issues=[].',
      ].filter(Boolean).join('\n'),
    },
  ];
}

function parseCriticContent(content) {
  try {
    const value = JSON.parse(String(content || '').replace(/```(?:json)?/gi, '').trim());
    if (!value || typeof value !== 'object') return null;
    const issues = (Array.isArray(value.issues) ? value.issues : [])
      .map((issue) => ({
        code: String(issue && issue.code ? issue.code : 'reviewer_finding').replace(/[^a-z0-9_]/gi, '_').slice(0, 48),
        severity: issue && issue.severity === 'block' ? 'block' : 'warn',
        note: String(issue && issue.note ? issue.note : '').slice(0, 600),
      }))
      .filter((issue) => issue.note);
    const verdict = value.verdict === 'repair' && issues.length ? 'repair' : 'pass';
    return { verdict, issues, summary: String(value.summary || '').slice(0, 400) };
  } catch {
    return null;
  }
}

function needsRepair(issues) {
  return issues.some((issue) => issue.severity === 'block');
}

/**
 * Verify a normalized decision. Deterministic checks always run; the critic
 * runs for user-facing decisions when time allows. Returns
 * { checked, verdict, issues, notes, critic, latency_ms }.
 */
async function verifyDecision({ decision, input, gateway, now = Date.now, budgetMs = 25000, useCritic = true, logger = console }) {
  const started = now();
  const deterministic = runDeterministicChecks(decision, input);
  const issues = [...deterministic];
  let critic = null;
  const userFacing = decision.action === 'answer' || decision.action === 'ask';
  if (useCritic && userFacing && gateway && budgetMs > 4000) {
    try {
      const result = await gateway.chatJson('verifier', buildCriticMessages(decision, input, deterministic), { maxTokens: 700, timeoutMs: Math.min(budgetMs, 30000), reasoningEffort: 'low', temperature: 0.1 });
      const parsed = parseCriticContent(result.content);
      critic = parsed
        ? { ...parsed, provider: result.provider, model: result.model, latency_ms: result.latency_ms }
        : { verdict: 'pass', issues: [], summary: 'critic returned unparseable output (ignored)', provider: result.provider, model: result.model, latency_ms: result.latency_ms, unparseable: true };
      if (parsed && parsed.verdict === 'repair') {
        for (const issue of parsed.issues) {
          if (!issues.some((existing) => existing.code === issue.code)) issues.push({ ...issue, source: 'critic' });
        }
      }
    } catch (error) {
      critic = { verdict: 'pass', issues: [], summary: 'critic unavailable (fail-open)', error: String(error && error.message || error).slice(0, 200) };
      if (logger && logger.warn) logger.warn(`[bob/verify] critic unavailable: ${critic.error}`);
    }
  }
  const verdict = needsRepair(issues) || (critic && critic.verdict === 'repair') ? 'repair' : issues.length ? 'pass_with_notes' : 'pass';
  return {
    checked: true,
    verdict,
    issues,
    notes: issues.filter((issue) => issue.severity !== 'style' || verdict === 'repair').map((issue) => issue.note),
    critic,
    latency_ms: now() - started,
  };
}

/** Last-resort mechanical scrub when a repair attempt still leaks — never lets a marker or raw id through. */
function scrubReply(reply) {
  return String(reply || '')
    .replace(/\[(INTERNAL|SYSTEM|DEBUG|ERROR|TOOL|QUERY|TRUNCATED)[^\]]*\]\s*/gi, '')
    .replace(UUID_RE, '[record id withheld]')
    .trim();
}

module.exports = {
  BLANKET_AFFIRMATIVE_RE,
  DRAFT_REQUEST_RE,
  autoRepairArgs,
  buildCriticMessages,
  countQuestionLines,
  needsRepair,
  parseCriticContent,
  runDeterministicChecks,
  scrubReply,
  verifyDecision,
};
