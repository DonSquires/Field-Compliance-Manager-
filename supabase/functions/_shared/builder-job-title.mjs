// Builder chat is the vibe-coding surface: the owner speaks plainly, and Bob must turn that into a clean job.
// Live 2026-10-21: the chat planner copied the owner's first sentence ("that last job was rejected as it was a
// job that has been supaseeded.") as the title, chose the frontend lane for an Atlas RPC gap, and pasted
// earlier proposals and refusals from the conversation into the brief. These helpers correct that
// deterministically, whatever the planner supplies.

const FILLER = /^(?:(?:ok(?:ay)?|hi|hey|right|so|now|also|and|then|bob|builder|please|pls|can you|could you|would you|i want you to|i need you to|i(?:'d| would) like you to|we need to|lets|let's)\b[\s,:-]*)+/i;
const REQUEST_VERB = /^(?:add|build|make|create|fix|repair|close|wire|update|change|remove|replace|rename|test|try|implement|redesign|improve|show|hide|move|split|merge|connect|refactor|retire|document|enable|disable|support|allow|let)\b/i;
// Sentences about earlier jobs or turns are context, not the request.
const CONTEXT_ONLY = /\b(?:(?:last|previous|prior|earlier|that|the other) (?:job|one|run|attempt|proposal)|was (?:rejected|cancelled|canceled|superseded|supaseeded)|has been (?:superseded|supaseeded|replaced|rejected))\b/i;
const IDENTIFIER = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b|\b(?:apps|supabase|services|scripts|test|docs|deploy|Build-Plan)\/[\w./-]+/;

export const BUILDER_JOB_TITLE_MAX = 90;

function clip(title) {
  if (title.length <= BUILDER_JOB_TITLE_MAX) return title;
  const cut = title.slice(0, BUILDER_JOB_TITLE_MAX);
  const space = cut.lastIndexOf(' ');
  return `${cut.slice(0, space > 40 ? space : BUILDER_JOB_TITLE_MAX).replace(/[,;:\s]+$/, '')}…`;
}

function flatten(text) {
  return String(text ?? '').replace(/https?:\/\/\S+/gi, ' ');
}

function sentences(text) {
  return flatten(text).split(/(?<=[.!?])\s+|\n+/).map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

// Identifiers the owner names as Atlas gaps ("atlas gap compact_cctv_inference_results").
export function atlasGapTargets(text) {
  const flat = flatten(text);
  if (!/\batlas\b/i.test(flat) || !/\bgaps?\b/i.test(flat)) return [];
  return [...new Set(flat.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) ?? [])].slice(0, 5);
}

export function builderJobTitle(text, fallback = 'Implement the requested FCM change') {
  const gaps = atlasGapTargets(text);
  if (gaps.length === 1) return clip(`Close Atlas gap: ${gaps[0]}`);
  const all = sentences(text);
  const scored = all.map((sentence, index) => {
    const cleaned = sentence.split(/\s[:;]\s|\s-\s/)[0].replace(FILLER, '').replace(/[.!?,;:\s]+$/, '').trim();
    let score = 0;
    if (REQUEST_VERB.test(cleaned)) score += 2;
    if (IDENTIFIER.test(cleaned)) score += 2;
    if (CONTEXT_ONLY.test(sentence)) score -= 3;
    return { cleaned, score, index };
  }).filter(item => item.cleaned);
  if (!scored.length) return fallback;
  const best = scored.reduce((a, b) => (b.score > a.score ? b : a));
  return clip(best.cleaned.charAt(0).toUpperCase() + best.cleaned.slice(1));
}

// The planner sometimes copies the conversation's earlier tool replies into a new brief. Those are other
// jobs' receipts and refusals, not evidence for this one.
const ECHO_TOOLS = 'create_builder_job|cancel_builder_job|retry_builder_job|approve_builder_job|reject_builder_job|web_research|delegate';
export function stripBuilderProposalEchoes(description) {
  const lines = String(description ?? '').split('\n');
  const out = [];
  let skipping = false;
  for (const line of lines) {
    if (new RegExp(`^\\s*(?:${ECHO_TOOLS}):`).test(line)) { skipping = true; continue; }
    if (skipping && (/^\s*[a-z_]+:\s/.test(line) && !new RegExp(`^\\s*(?:${ECHO_TOOLS}):`).test(line) || /^\s*(?:Required (?:verification|delivery) contract|Acceptance):?/i.test(line))) skipping = false;
    if (!skipping) out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function atlasGapBrief(targets) {
  if (!targets.length) return '';
  return [
    `Target Atlas gap${targets.length > 1 ? 's' : ''}: ${targets.join(', ')}`,
    '- Confirm each target in the live Atlas gap report (entity type, present, wired=false) before changing anything.',
    '- Close exactly one gap. Find the real caller (cron job, trigger, edge function, script) or show there is none.',
    '- Real remedies: register a caller the Atlas scanner misses (scripts/atlas-refresh.js), wire a governed caller, or propose retiring a dead entity by migration. Never edit the AtlasPage.tsx fallback seed or UI copy.',
    '- After merge, refresh Atlas and confirm the entity reports wired=true, or report the blocker with evidence.'
  ].join('\n');
}
