// Bob's draft of the two-paragraph executive summary that opens a monthly
// client report. The brief is built only from the frozen, client-facing pack
// (monthly_report_packs.data.activityReport and .activity_lines), which has
// already had identified persons redacted and withholds travel, administration,
// staff and system detail, so nothing leaves FCM that the client report would
// not itself show. The draft is a suggestion: it fills the reviewer's
// Executive summary box and reaches the client only once a provider
// administrator saves or publishes the review.

import { NO_PLACE_LABEL, isRoutineLine, labeller, readActivityLines, readActivityReport } from './report-activity-sections.mjs';

export const EXECUTIVE_SUMMARY_MAX_CHARS = 4000;
export const BRIEF_ENTRY_LIMIT = 150;
const NOTE_LIMIT = 600;
const MODEL_TIMEOUT_MS = 60_000;

/** @param {unknown} value @returns {Record<string, unknown> | null} */
const obj = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? /** @type {Record<string, unknown>} */ (value) : null);
/** @param {unknown} value @returns {Record<string, unknown>[]} */
const rows = (value) => (Array.isArray(value) ? value.map(obj).filter((item) => item !== null) : []);
/** @param {unknown} value */
const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
/** @param {unknown} value */
const text = (value) => (typeof value === 'string' && value.trim() ? value.trim() : '');
/** @param {string} value @param {number} limit */
const clip = (value, limit) => (value.length > limit ? `${value.slice(0, limit - 1).trimEnd()}…` : value);

/** Incidents first, then observations, CCTV activity, then other written entries. @param {Record<string, unknown>} line */
function briefRank(line) {
  if (text(line.k) === 'incident') return 0;
  if (text(line.k) === 'observation') return 1;
  if (text(line.c) === 'camera_activation') return 2;
  return 3;
}

/**
 * The facts Bob may use: the period's figures and the written entries most
 * likely to matter to the client, in date order. Returns null for packs with
 * no client activity report.
 * @param {unknown} data
 * @param {unknown} activityLines
 * @param {{ clientName?: string, agreementName?: string, period?: string }} [context]
 */
export function executiveSummaryBrief(data, activityLines, context = {}) {
  const report = readActivityReport(data);
  if (!report) return null;
  const label = labeller(report);
  const totals = obj(report.totals) ?? {};
  const pest = obj(report.pestControl) ?? {};
  const incidents = obj(report.incidents) ?? {};
  const observations = obj(report.observations) ?? {};
  const hunters = obj(report.hunterReturns);
  const { lines } = readActivityLines(activityLines);

  const written = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => text(line.k) === 'incident' || (!isRoutineLine(line) && (text(line.n) || text(line.ac) || text(line.ti))));
  const chosen = written
    .sort((left, right) => briefRank(left.line) - briefRank(right.line) || left.index - right.index)
    .slice(0, BRIEF_ENTRY_LIMIT)
    .sort((left, right) => left.index - right.index)
    .map(({ line }) => {
      const incident = text(line.k) === 'incident';
      return Object.fromEntries(Object.entries({
        date: text(line.d),
        location: text(line.p) || NO_PLACE_LABEL,
        type: incident ? label('incidentType', line.it) || 'Incident' : label('category', line.c),
        severity: incident ? label('severity', line.sev || 'standard') : '',
        status: incident ? label('incidentStatus', line.st || 'open') : '',
        issue: incident ? '' : text(line.ti),
        detail: clip(text(line.n), NOTE_LIMIT),
        action: clip(text(line.ac), NOTE_LIMIT),
      }).filter(([, value]) => value));
    });

  const figures = {
    locationsWithActivity: num(totals.places),
    entriesRecorded: num(totals.entries),
    patrolsAndSiteChecks: num(totals.patrolVisits),
    cctvActivations: num(totals.cameraActivations),
    pestControlEntries: num(pest.entries),
    pestCulls: rows(pest.bySpecies).reduce((sum, row) => sum + num(row.culls), 0),
    maintenanceEntries: num(obj(report.maintenance)?.entries),
    incidents: num(incidents.total),
    incidentsBySeverity: rows(incidents.bySeverity).map((row) => ({ severity: label('severity', row.code), count: num(row.entries) })),
    observations: num(observations.total),
    photos: num(totals.photos),
    activityTypes: rows(report.categories).map((row) => ({ type: label('category', row.code), entries: num(row.entries) })),
    ...(hunters ? {
      hunterReturns: num(hunters.returns),
      hunterAnimals: num(hunters.animals),
      hunterAnimalsBySpecies: rows(hunters.bySpecies).map((row) => ({ species: text(row.species), animals: num(row.animals) })),
    } : {}),
  };

  return {
    client: text(context.clientName),
    agreement: text(context.agreementName),
    period: text(context.period),
    figures,
    entries: chosen,
    entriesNotIncluded: Math.max(written.length - chosen.length, 0),
  };
}

export const EXECUTIVE_SUMMARY_INSTRUCTIONS = [
  "You write the executive summary that opens a security and land-management contractor's monthly accountability report to its client.",
  'Write exactly two paragraphs of plain prose separated by one blank line. No title, headings, bullet points, numbered lists, bold or other markdown.',
  'Paragraph one, the operational overview: summarise the work delivered in the period using the figures provided, quoting the exact numbers (never round, total or invent figures), then give one sentence on the overall risk picture.',
  'Paragraph two, significant issues: set out the most material matters found in the entries, such as thefts, security breaches, trespass, damage, tampering, and equipment or infrastructure failures. Group related entries by theme, name the location, and give concrete facts such as quantities and vehicle registrations where recorded, plus any action taken or still required. If nothing material was recorded, say so plainly.',
  'Use a formal, factual register for a client executive. Do not tell a story, speculate about motives, dramatise, give a day-by-day account, or offer advice the entries do not support.',
  'Never name or describe an identifiable person. Where an entry says R & M have identified a person, say a person has been identified.',
  'Use only facts in the brief. Use New Zealand English. Keep the summary under 350 words.',
].join('\n');

/**
 * Plain paragraphs only: strips reasoning blocks and markdown, folds anything
 * past the second paragraph into the second, and keeps within the review
 * field's limit.
 * @param {unknown} raw
 */
export function cleanExecutiveSummary(raw) {
  const value = typeof raw === 'string' ? raw : '';
  const paragraphs = value
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/\r\n/g, '\n')
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph
      .split('\n')
      .map((line) => line.replace(/^\s*(#{1,6}\s+|[-*•]\s+|\d+[.)]\s+)/, '').trim())
      .filter(Boolean)
      .join(' ')
      .replace(/\*\*|__|`/g, '')
      .replace(/\s+/g, ' ')
      .trim())
    .filter((paragraph) => paragraph && !/^executive summary\b[^.]*$/i.test(paragraph));
  const folded = paragraphs.length > 2 ? [paragraphs[0], paragraphs.slice(1).join(' ')] : paragraphs;
  let summary = folded.join('\n\n');
  if (summary.length > EXECUTIVE_SUMMARY_MAX_CHARS) {
    const cut = summary.slice(0, EXECUTIVE_SUMMARY_MAX_CHARS);
    const end = cut.lastIndexOf('. ');
    summary = end > EXECUTIVE_SUMMARY_MAX_CHARS / 2 ? cut.slice(0, end + 1) : cut.trimEnd();
  }
  return summary;
}

/**
 * The approved stack, Ollama Cloud first, then OpenAI (owner direction
 * 2026-10-18). Each provider is tried once; the first usable draft wins.
 * @param {Record<string, string | undefined>} env
 */
export function summaryProviders(env) {
  /** @type {Array<{ provider: string, model: string, url: string, headers: Record<string, string>, body: (messages: unknown[]) => unknown, read: (payload: any) => unknown }>} */
  const providers = [];
  const ollamaToken = text(env.OLLAMA_API_TOKEN);
  if (ollamaToken) {
    const model = text(env.REPORT_SUMMARY_OLLAMA_MODEL) || 'gpt-oss:120b';
    providers.push({
      provider: 'ollama_cloud',
      model,
      url: `${(text(env.OLLAMA_CLOUD_BASE_URL) || 'https://ollama.com').replace(/\/+$/, '')}/api/chat`,
      headers: { Authorization: `Bearer ${ollamaToken}`, 'Content-Type': 'application/json' },
      body: (messages) => ({ model, messages, stream: false, options: { temperature: 0.2 } }),
      read: (payload) => payload?.message?.content,
    });
  }
  const openAiKey = text(env.OPENAI_API_KEY);
  if (openAiKey) {
    const model = text(env.REPORT_SUMMARY_OPENAI_MODEL) || text(env.OPENAI_MODEL) || 'gpt-4o-mini';
    const reasoning = /^(gpt-5|o\d)/i.test(model);
    providers.push({
      provider: 'openai',
      model,
      url: `${(text(env.OPENAI_BASE_URL) || 'https://api.openai.com/v1').replace(/\/+$/, '')}/chat/completions`,
      headers: { Authorization: `Bearer ${openAiKey}`, 'Content-Type': 'application/json' },
      body: (messages) => (reasoning ? { model, messages } : { model, messages, temperature: 0.2 }),
      read: (payload) => payload?.choices?.[0]?.message?.content,
    });
  }
  return providers;
}

/**
 * @param {{ brief: unknown, env: Record<string, string | undefined>, fetchImpl?: typeof fetch, timeoutMs?: number }} options
 * @returns {Promise<{ summary: string, provider: string, model: string }>}
 */
export async function draftExecutiveSummary({ brief, env, fetchImpl = fetch, timeoutMs = MODEL_TIMEOUT_MS }) {
  const providers = summaryProviders(env);
  if (!providers.length) throw new Error('No drafting model is configured');
  const messages = [
    { role: 'system', content: EXECUTIVE_SUMMARY_INSTRUCTIONS },
    { role: 'user', content: `Report brief (JSON):\n${JSON.stringify(brief)}` },
  ];
  const failures = [];
  for (const candidate of providers) {
    try {
      const response = await fetchImpl(candidate.url, {
        method: 'POST',
        headers: candidate.headers,
        body: JSON.stringify(candidate.body(messages)),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const summary = cleanExecutiveSummary(candidate.read(await response.json()));
      if (summary.length < 80) throw new Error('empty draft');
      if (summary.split(/\n\s*\n/).length !== 2) throw new Error('model did not return exactly two paragraphs');
      return { summary, provider: candidate.provider, model: candidate.model };
    } catch (error) {
      failures.push(`${candidate.provider}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`Bob could not draft the summary (${failures.join('; ')})`);
}
