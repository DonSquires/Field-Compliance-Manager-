// Bob's potential-incident check over a monthly client report's logged
// activity and officer notes. Bob judges each entry by its meaning, guided by
// the report_incident_triage knowledge and training cards and by the
// reviewer's own recent decisions; there is no keyword list. Bob only
// highlights: a provider reviewer confirms or clears every highlight through
// set_report_incident_triage. Only the frozen, client-facing line text (already
// redacted of identified persons) is sent to the model.

import { INCIDENT_TYPE_LABELS, NO_PLACE_LABEL, activityLineKey, isRoutineLine, labeller, readActivityLines, readActivityReport } from './report-activity-sections.mjs';

export const TRIAGE_BATCH_SIZE = 60;
export const TRIAGE_EXAMPLE_LIMIT = 30;
export const INCIDENT_TYPES = Object.keys(INCIDENT_TYPE_LABELS);
const FIELD_LIMIT = 600;
const EXCERPT_LIMIT = 1000;

/** @param {unknown} value */
const text = (value) => (typeof value === 'string' && value.trim() ? value.trim() : '');
/** @param {string} value @param {number} limit */
const clip = (value, limit) => (value.length > limit ? `${value.slice(0, limit - 1).trimEnd()}…` : value);

/**
 * Logged entries Bob should read: anything with written detail that is not
 * already a recorded incident or a routine patrol with nothing to report.
 * Identical lines share a key and are assessed once.
 * @param {unknown} data
 * @param {unknown} activityLines
 */
export function triageCandidates(data, activityLines) {
  const report = readActivityReport(data);
  if (!report) return [];
  const label = labeller(report);
  const { lines } = readActivityLines(activityLines);
  const seen = new Set();
  const candidates = [];
  for (const line of lines) {
    if (text(line.k) === 'incident' || isRoutineLine(line)) continue;
    const title = text(line.ti);
    const note = text(line.n);
    const action = text(line.ac);
    if (!title && !note && !action) continue;
    const date = text(line.d);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const key = activityLineKey(line);
    if (seen.has(key)) continue;
    seen.add(key);
    const kind = text(line.k) === 'observation' ? `${label('module', line.mo || 'unknown')} observation` : label('category', line.c);
    const activity = [label('activity', line.a), label('subject', line.s), label('species', line.sp), label('equipment', line.eq)].filter(Boolean).join(', ');
    candidates.push({
      key,
      date,
      place: text(line.p) || NO_PLACE_LABEL,
      excerpt: clip([title, note, action && `Action: ${action}`].filter(Boolean).join(' | '), EXCERPT_LIMIT),
      prompt: Object.fromEntries(Object.entries({
        date,
        time: text(line.t),
        place: text(line.p) || NO_PLACE_LABEL,
        kind,
        activity,
        issue: clip(title, FIELD_LIMIT),
        note: clip(note, FIELD_LIMIT),
        action: clip(action, FIELD_LIMIT),
      }).filter(([, value]) => value)),
    });
  }
  return candidates;
}

export const TRIAGE_INSTRUCTIONS = [
  'You are Bob, the field compliance assistant for a security and land-management contractor. You read logged field activity and officer notes for one client month and point out entries that may be incidents the client should know about.',
  'Think about what each entry actually describes. Do not match keywords: a routine check that mentions a gate or a lock is not an incident, and an entry that describes harm, loss, unauthorised access or a failed control is one even if it uses ordinary words.',
  'Use your knowledge cards, training cards and the reviewer\'s recent decisions below. Where the reviewer\'s decisions show how this client treats a kind of entry, follow them.',
  `Allowed types: ${INCIDENT_TYPES.join(', ')}.`,
  'Return JSON only, with no prose and no code fences, in exactly this shape: {"flags":[{"i":<entry number>,"type":"<allowed type>","reason":"<one sentence, max 30 words, saying what in the entry makes it a potential incident>","confidence":<0 to 1>}]}.',
  'Include only entries that may be incidents. Return {"flags":[]} when none are. Never name or describe a person in a reason.',
].join('\n');

/**
 * The system prompt: instructions, Bob's cards and the reviewer's recent
 * decisions as worked examples. Reviewer notes are provider-only free text and
 * are never sent to a model; only the redacted excerpt and the decision are.
 * @param {Array<{ title?: unknown, content?: unknown }>} cards
 * @param {Array<{ excerpt?: unknown, decision?: unknown, incident_type?: unknown }>} examples
 */
export function triageSystemPrompt(cards, examples) {
  const cardText = (Array.isArray(cards) ? cards : [])
    .map((card) => `### ${text(card.title)}\n${text(card.content)}`)
    .filter((value) => value.length > 5)
    .join('\n\n');
  const exampleText = (Array.isArray(examples) ? examples : [])
    .filter((row) => text(row.excerpt) && (row.decision === 'incident' || row.decision === 'not_incident'))
    .slice(0, TRIAGE_EXAMPLE_LIMIT)
    .map((row) => `- "${clip(text(row.excerpt), 300)}" -> ${row.decision === 'incident' ? `incident (${text(row.incident_type) || 'other'})` : 'not an incident'}`)
    .join('\n');
  return [
    TRIAGE_INSTRUCTIONS,
    cardText && `\n## Knowledge and training cards\n${cardText}`,
    exampleText && `\n## Reviewer's recent decisions (follow these)\n${exampleText}`,
  ].filter(Boolean).join('\n');
}

/** @param {Array<{ prompt: Record<string, string> }>} batch */
export function triageBatchMessage(batch) {
  return `Entries (JSON). "i" is the entry number to use in your answer:\n${JSON.stringify(batch.map((candidate, i) => ({ i, ...candidate.prompt })))}`;
}

/**
 * Bob's flags for one batch, validated: entry numbers in range, allowed types
 * only, reason clipped, confidence clamped. Throws when the answer is not the
 * requested JSON so the next provider is tried.
 * @param {unknown} content
 * @param {number} batchSize
 * @returns {Map<number, { type: string, reason: string, confidence: number | null }>}
 */
export function parseTriageFlags(content, batchSize) {
  const raw = typeof content === 'string' ? content.replace(/<think>[\s\S]*?<\/think>/gi, '') : '';
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('model did not return JSON');
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    throw new Error('model returned malformed JSON');
  }
  const flags = parsed && typeof parsed === 'object' ? /** @type {Record<string, unknown>} */ (parsed).flags : null;
  if (!Array.isArray(flags)) throw new Error('model JSON has no flags list');
  /** @type {Map<number, { type: string, reason: string, confidence: number | null }>} */
  const result = new Map();
  for (const flag of flags) {
    if (!flag || typeof flag !== 'object') continue;
    const value = /** @type {Record<string, unknown>} */ (flag);
    const index = typeof value.i === 'number' ? value.i : Number(value.i);
    if (!Number.isInteger(index) || index < 0 || index >= batchSize) continue;
    const type = text(value.type).toLowerCase();
    const confidence = typeof value.confidence === 'number' && Number.isFinite(value.confidence)
      ? Math.round(Math.min(Math.max(value.confidence, 0), 1) * 100) / 100
      : null;
    result.set(index, {
      type: INCIDENT_TYPES.includes(type) ? type : 'other',
      reason: clip(text(value.reason), 600),
      confidence,
    });
  }
  return result;
}
