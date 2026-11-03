// Bob's draft of the exception-based executive summary that opens a monthly
// client report. The brief is built only from the frozen, client-facing pack
// (monthly_report_packs.data.activityReport and .activity_lines), which has
// already had identified persons redacted and withholds travel, administration,
// staff and system detail, plus the reviewer's incident triage and the figures
// (never the itemised lines) of the two months before, so nothing leaves FCM
// that the client report would not itself show. The draft is a suggestion: it
// fills the reviewer's Executive summary box and reaches the client only once
// a provider administrator saves or publishes the review.

import { NO_PLACE_LABEL, activityLineKey, incidentTypeLabel, isRoutineLine, labeller, readActivityLines, readActivityReport } from './report-activity-sections.mjs';

export const EXECUTIVE_SUMMARY_MAX_CHARS = 4000;
export const BRIEF_ENTRY_LIMIT = 150;
const NOTE_LIMIT = 600;
const MODEL_TIMEOUT_MS = 70_000;
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

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

/** "2026-10-01" -> "October 2026". @param {unknown} value */
export function reportMonthLabel(value) {
  const match = /^(\d{4})-(\d{2})/.exec(text(value));
  return match ? `${MONTH_NAMES[Number(match[2]) - 1]} ${match[1]}` : text(value);
}

/**
 * @typedef {{ line_key?: unknown, bob_flagged?: unknown, bob_incident_type?: unknown, bob_reason?: unknown, decision?: unknown, incident_type?: unknown }} TriageRow
 */

/** Confirmed incidents, then Bob's open flags, then observations, CCTV, other written entries; cleared entries last. */
function briefRank(line, triage) {
  if (text(line.k) === 'incident' || triage?.decision === 'incident') return 0;
  if (triage?.decision === 'not_incident') return 5;
  if (triage?.bob_flagged === true) return 1;
  if (text(line.k) === 'observation') return 2;
  if (text(line.c) === 'camera_activation') return 3;
  return 4;
}

/** @param {Record<string, unknown>} report @param {ReturnType<typeof labeller>} label */
function pestFigures(report, label) {
  const pest = obj(report.pestControl) ?? {};
  const hunters = obj(report.hunterReturns);
  return {
    pestControlEntries: num(pest.entries),
    cullsAndSightingsBySpecies: rows(pest.bySpecies)
      .map((row) => ({ species: label('species', row.code), culls: num(row.culls), sightings: num(row.sightings) }))
      .filter((row) => row.culls || row.sightings),
    ...(hunters ? {
      hunterReportedAnimalsBySpecies: rows(hunters.bySpecies).map((row) => ({ species: text(row.species), animals: num(row.animals) })),
    } : {}),
  };
}

/** @param {Record<string, unknown>} report */
function activityFigures(report) {
  const totals = obj(report.totals) ?? {};
  return {
    entriesRecorded: num(totals.entries),
    incidentsRecorded: num(obj(report.incidents)?.total),
    observations: num(obj(report.observations)?.total),
    cctvActivations: num(totals.cameraActivations),
  };
}

/**
 * The two months before the period from report_pack_trend_context, labelled
 * for Bob. A month with nothing recorded is marked as not comparable.
 * @param {unknown} trend
 */
export function priorMonthFigures(trend) {
  return rows(obj(trend)?.months).map((month) => {
    const report = obj(month.report);
    const label = report ? labeller(report) : null;
    const recorded = Boolean(report && (num(obj(report.totals)?.entries) > 0 || num(obj(report.hunterReturns)?.returns) > 0));
    if (!report || !label || !recorded) return { month: reportMonthLabel(month.month), comparable: false };
    return {
      month: reportMonthLabel(month.month),
      comparable: true,
      ...activityFigures(report),
      confirmedIncidentsByType: rows(month.confirmedIncidents).map((row) => ({ type: incidentTypeLabel(row.type), count: num(row.count) })),
      ...pestFigures(report, label),
    };
  });
}

/** Weeks of the month by day: 1-7, 8-14, 15-21, 22 to month end. @param {string} date */
function weekOf(date) {
  const day = Number(date.slice(8, 10));
  if (!day) return -1;
  return Math.min(Math.floor((day - 1) / 7), 3);
}

/**
 * The facts Bob may use: the written entries most likely to matter to the
 * client (with the reviewer's incident decisions and Bob's open flags), pest
 * figures, the month by week and the two months before. Returns null for packs
 * with no client activity report.
 * @param {unknown} data
 * @param {unknown} activityLines
 * @param {{ clientName?: string, agreementName?: string, period?: string, periodStart?: string, triage?: TriageRow[], trend?: unknown }} [context]
 */
export function executiveSummaryBrief(data, activityLines, context = {}) {
  const report = readActivityReport(data);
  if (!report) return null;
  const label = labeller(report);
  const { lines } = readActivityLines(activityLines);
  /** @type {Map<string, TriageRow>} */
  const triageByKey = new Map((Array.isArray(context.triage) ? context.triage : [])
    .filter((row) => typeof row?.line_key === 'string')
    .map((row) => [/** @type {string} */ (row.line_key), row]));

  const assessed = lines.map((line, index) => ({ line, index, triage: triageByKey.get(activityLineKey(line)) }));
  const written = assessed
    .filter(({ line }) => text(line.k) === 'incident' || (!isRoutineLine(line) && (text(line.n) || text(line.ac) || text(line.ti))));
  const chosen = [...written]
    .sort((left, right) => briefRank(left.line, left.triage) - briefRank(right.line, right.triage) || left.index - right.index)
    .slice(0, BRIEF_ENTRY_LIMIT)
    .sort((left, right) => left.index - right.index)
    .map(({ line, triage }) => {
      const incident = text(line.k) === 'incident';
      let review = '';
      if (triage?.decision === 'incident') review = `Confirmed incident on review: ${incidentTypeLabel(triage.incident_type)}`;
      else if (triage?.decision === 'not_incident') review = 'Cleared on review: not an incident';
      else if (triage?.bob_flagged === true) review = `Potential ${incidentTypeLabel(triage.bob_incident_type).toLowerCase()}, not yet reviewed`;
      return Object.fromEntries(Object.entries({
        date: text(line.d),
        location: text(line.p) || NO_PLACE_LABEL,
        type: incident ? label('incidentType', line.it) || 'Incident' : label('category', line.c),
        severity: incident ? label('severity', line.sev || 'standard') : '',
        status: incident ? label('incidentStatus', line.st || 'open') : '',
        review,
        issue: incident ? '' : text(line.ti),
        detail: clip(text(line.n), NOTE_LIMIT),
        action: clip(text(line.ac), NOTE_LIMIT),
      }).filter(([, value]) => value));
    });

  const weeks = ['Days 1-7', 'Days 8-14', 'Days 15-21', 'Day 22 to month end'].map((week) => ({ week, entries: 0, incidents: 0, potentialIncidents: 0, observations: 0 }));
  for (const { line, triage } of assessed) {
    const bucket = weeks[weekOf(text(line.d))];
    if (!bucket) continue;
    bucket.entries += 1;
    if (text(line.k) === 'incident' || triage?.decision === 'incident') bucket.incidents += 1;
    else if (triage?.bob_flagged === true && triage.decision !== 'not_incident') bucket.potentialIncidents += 1;
    if (text(line.k) === 'observation') bucket.observations += 1;
  }

  const confirmed = new Map();
  for (const { triage } of assessed) {
    if (triage?.decision !== 'incident') continue;
    const type = incidentTypeLabel(triage.incident_type);
    confirmed.set(type, (confirmed.get(type) ?? 0) + 1);
  }

  return {
    client: text(context.clientName),
    agreement: text(context.agreementName),
    period: text(context.period),
    month: reportMonthLabel(context.periodStart),
    thisMonth: {
      ...activityFigures(report),
      confirmedIncidentsByType: [...confirmed.entries()].map(([type, count]) => ({ type, count })),
      ...pestFigures(report, label),
      byWeek: weeks,
    },
    previousMonths: priorMonthFigures(context.trend),
    entries: chosen,
    entriesNotIncluded: Math.max(written.length - chosen.length, 0),
  };
}

export const EXECUTIVE_SUMMARY_INSTRUCTIONS = [
  'You are an expert corporate security analyst. Your task is to analyze monthly security accountability logs and extract a concise, exception-based Executive Summary tailored for corporate clients.',
  '',
  'Strictly adhere to the following formatting and stylistic rules:',
  '1. Tone: Maintain a highly professional, objective, precise, and concise corporate tone.',
  '2. Style: Strictly avoid narrative storytelling, conversational preambles, introductory filler, or concluding remarks. Exclude all high-level operational statistics and data volumes (such as total counts of patrols, entries, culls, or hunter returns), as these are provided separately in a dedicated metrics section. Numbers are used only where they describe a specific matter or a comparison in the Pest Control and Trends sections.',
  '3. Formatting: Structure the response strictly with clear headers and bullet points. Headers are whole lines in bold. Bullets start with "* ". Bold key numbers, specific locations, vehicle registrations, and critical entities with **double asterisks**. No other markdown, tables or code blocks.',
  '4. Language: Use professional security terminology (e.g., "perimeter compromise", "infrastructure vulnerabilities", "unauthorized access").',
  '',
  'Structure the output exactly as follows:',
  '',
  '**Executive Summary: <month and year from the brief>**',
  '',
  '**Significant Security Breaches & Critical Infrastructure Issues**',
  'Bullet-point only the most serious operational risks, failures, and incidents recorded during the period. Do not summarize routine log entries. Focus strictly on systemic vulnerabilities or severe asset threats, under these bullets where applicable (omit a bullet that has nothing to report; group related entries into one bullet):',
  '* **Targeted Commercial Theft:** theft, missing fuel, stolen machinery or tools, with specific locations, suspected entities, and vehicle descriptions/registrations.',
  '* **Perimeter Compromise & Trespass:** gates bypassed, locks forced, roadblock logs winched or manipulated, and confirmed instances of active trespassing.',
  '* **Lock & Hardware Failures:** electronic lock failures, low batteries, hardware cut or bypassed by patrols to gain entry, or missing/vandalized perimeter infrastructure.',
  '* **Surveillance Tampering & Blind Spots:** compromised, discovered or stolen security cameras, missing or wiped SD cards, and gaps in the arterial camera network.',
  'If nothing serious was recorded, write one bullet saying no significant security breaches or infrastructure failures were recorded.',
  '',
  '**Pest Control**',
  '2 to 4 bullets: the most common pest observed, culled or killed; any significant or reduced numbers by species; and how this compares with the previous two months (thisMonth versus previousMonths). Treat hunter-reported animals as reported by permit holders, separately from contractor culls. Where a previous month is not comparable, say there is no comparable prior data for it.',
  '',
  '**Trends**',
  '2 to 4 bullets: how incidents and potential incidents were spread across the month (thisMonth.byWeek), any concentration by location or type, and how the period compares with the previous two months for incidents, confirmed incident types and observations. Where there is no comparable prior data, say so in one bullet rather than guessing.',
  '',
  'Rules for the facts:',
  '- Use only facts in the brief. Never invent, round or total figures that are not given.',
  '- Entries with review "Confirmed incident on review" are incidents. Entries with review "Cleared on review: not an incident" must not be reported as breaches. Entries marked "not yet reviewed" are potential incidents: report them only if the entry itself clearly describes a serious matter, and do not call them confirmed.',
  '- Never name or describe an identifiable person. Where an entry says a person has been identified, say "a person has been identified". Vehicle descriptions and registrations may be given.',
  '- Use New Zealand English spelling apart from the fixed headings and the terms above. Keep the summary under 450 words.',
].join('\n');

/**
 * Keeps Bob's headers, bullets and **bold**, removes reasoning blocks, code
 * fences and other markdown, and keeps within the review field's limit.
 * @param {unknown} raw
 */
export function cleanExecutiveSummary(raw) {
  const value = typeof raw === 'string' ? raw : '';
  const lines = value
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```[a-z]*\n?/gi, '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      const heading = /^#{1,6}\s+(.+)$/.exec(trimmed);
      if (heading) return `**${heading[1].replace(/\*\*/g, '').trim()}**`;
      const bullet = /^(?:[-*•]|\d+[.)])\s+(.+)$/.exec(trimmed);
      if (bullet) return `* ${bullet[1].trim()}`;
      return trimmed;
    })
    .map((line) => line.replace(/__|`/g, '').replace(/[ \t]+/g, ' '));
  let summary = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (summary.length > EXECUTIVE_SUMMARY_MAX_CHARS) {
    const cut = summary.slice(0, EXECUTIVE_SUMMARY_MAX_CHARS);
    const end = cut.lastIndexOf('\n');
    summary = (end > EXECUTIVE_SUMMARY_MAX_CHARS / 2 ? cut.slice(0, end) : cut).trimEnd();
  }
  return summary;
}

/**
 * Bob's draft must open with the Executive Summary header and set out its
 * points as bullets. A missing header is supplied from the brief's month.
 * @param {string} summary
 * @param {unknown} brief
 */
export function finaliseExecutiveSummary(summary, brief) {
  let result = summary;
  if (!/^\*\*Executive Summary\b/i.test(result)) {
    const month = text(obj(brief)?.month);
    result = `**Executive Summary${month ? `: ${month}` : ''}**\n\n${result}`;
  }
  if (result.length > EXECUTIVE_SUMMARY_MAX_CHARS) result = cleanExecutiveSummary(result);
  return result;
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
 * Sends one conversation to each configured provider in turn; the first
 * response that `accept` returns a value for wins.
 * @template T
 * @param {{ messages: unknown[], env: Record<string, string | undefined>, accept: (content: unknown) => T, fetchImpl?: typeof fetch, timeoutMs?: number, failurePrefix?: string }} options
 * @returns {Promise<{ value: T, provider: string, model: string }>}
 */
export async function completeWithProviders({ messages, env, accept, fetchImpl = fetch, timeoutMs = MODEL_TIMEOUT_MS, failurePrefix = 'Bob could not complete the request' }) {
  const providers = summaryProviders(env);
  if (!providers.length) throw new Error('No drafting model is configured');
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
      return { value: accept(candidate.read(await response.json())), provider: candidate.provider, model: candidate.model };
    } catch (error) {
      failures.push(`${candidate.provider}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`${failurePrefix} (${failures.join('; ')})`);
}

/**
 * @param {{ brief: unknown, env: Record<string, string | undefined>, fetchImpl?: typeof fetch, timeoutMs?: number }} options
 * @returns {Promise<{ summary: string, provider: string, model: string }>}
 */
export async function draftExecutiveSummary({ brief, env, fetchImpl = fetch, timeoutMs = MODEL_TIMEOUT_MS }) {
  const messages = [
    { role: 'system', content: EXECUTIVE_SUMMARY_INSTRUCTIONS },
    { role: 'user', content: `Report brief (JSON):\n${JSON.stringify(brief)}` },
  ];
  const { value, provider, model } = await completeWithProviders({
    messages,
    env,
    fetchImpl,
    timeoutMs,
    failurePrefix: 'Bob could not draft the summary',
    accept: (content) => {
      const summary = finaliseExecutiveSummary(cleanExecutiveSummary(content), brief);
      if (summary.length < 120) throw new Error('empty draft');
      if (!/^\* /m.test(summary)) throw new Error('model did not return bullet points');
      return summary;
    },
  });
  return { summary: value, provider, model };
}
