// Bob's privacy oracle for client reports. Before a monthly report reaches a
// client (PDF, email or portal), Bob reads every client-facing entry and the
// reviewer's wording and points out the exact words that identify a private
// individual: names of suspects, offenders, members of the public, neighbours,
// landowners or staff, and any personal contact details the database rules
// missed. Bob judges by meaning, not a word list; known places, the client and
// the provider are given to him as never-personal terms and are also protected
// in code, because many forest blocks carry family names ("Smiths", "Norris").
// The pack's own copy is reworded ("[name withheld]") so nothing downstream can
// show the name; the source records keep the full text for authorised staff.
// Reworded lines keep their original content key (lk) so incident decisions
// still match, and checked lines carry pv so they are not read again. Withheld
// words are never stored: the pack is client-readable.

import { activityLineKey } from './report-activity-sections.mjs';

export const PRIVACY_BATCH_SIZE = 40;
export const PRIVACY_VERSION = 1;
export const NAME_WITHHELD = '[name withheld]';
export const DETAILS_WITHHELD = '[details withheld]';
export const LINE_TEXT_FIELDS = /** @type {const} */ (['ti', 'n', 'ac']);
export const EDITORIAL_TEXT_FIELDS = /** @type {const} */ (['title', 'executive_summary', 'client_notes', 'follow_up']);

/** @param {unknown} value @returns {Record<string, unknown> | null} */
const obj = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? /** @type {Record<string, unknown>} */ (value) : null);
/** @param {unknown} value */
const text = (value) => (typeof value === 'string' && value.trim() ? value.trim() : '');
/** @param {string} value */
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** @param {string} value */
const fold = (value) => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** cyrb53 (public domain) of a string, hex. Used to record which wording was checked without storing it. */
export function textDigest(value) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

/** The reviewer's client-facing wording, trimmed, in a fixed order. @param {unknown} editorial */
export function editorialText(editorial) {
  const value = obj(editorial) ?? {};
  return Object.fromEntries(EDITORIAL_TEXT_FIELDS.map((field) => [field, text(value[field])]));
}

/** Digest of the reviewer's wording, so a later edit needs a fresh check. @param {unknown} editorial */
export function editorialDigest(editorial) {
  return textDigest(JSON.stringify(EDITORIAL_TEXT_FIELDS.map((field) => editorialText(editorial)[field])));
}

/** @param {Record<string, unknown>} line */
const hasLineText = (line) => LINE_TEXT_FIELDS.some((field) => text(line[field]));

/**
 * Lines with client-facing wording Bob has not checked yet, grouped by
 * identical wording so each wording is read once.
 * @param {unknown} activityLines
 * @returns {Array<{ indexes: number[], fields: Record<string, string> }>}
 */
export function privacyCandidates(activityLines) {
  const document = obj(activityLines);
  if (!document || !Array.isArray(document.lines)) return [];
  /** @type {Map<string, { indexes: number[], fields: Record<string, string> }>} */
  const byText = new Map();
  document.lines.forEach((raw, index) => {
    const line = obj(raw);
    if (!line || line.pv === PRIVACY_VERSION || !hasLineText(line)) return;
    const fields = Object.fromEntries(LINE_TEXT_FIELDS.map((field) => [field, text(line[field])]).filter(([, value]) => value));
    const signature = JSON.stringify(fields);
    const existing = byText.get(signature);
    if (existing) existing.indexes.push(index);
    else byText.set(signature, { indexes: [index], fields });
  });
  return [...byText.values()];
}

/**
 * Words that are never a private individual in this report: its places
 * (many blocks carry family names), the client, the provider and the agreement.
 * @param {unknown} activityLines
 * @param {string[]} [extra]
 */
export function protectedTerms(activityLines, extra = []) {
  const terms = new Set();
  const add = (/** @type {string} */ value) => {
    const cleaned = text(value);
    if (!cleaned) return;
    terms.add(cleaned);
    const bare = cleaned.replace(/\s*\([^)]*\)\s*$/, '').trim();
    if (bare) terms.add(bare);
  };
  const document = obj(activityLines);
  for (const raw of Array.isArray(document?.lines) ? document.lines : []) add(text(obj(raw)?.p));
  extra.forEach(add);
  return [...terms].sort((left, right) => left.localeCompare(right));
}

export const PRIVACY_INSTRUCTIONS = [
  'You are Bob\'s privacy oracle for a security contractor\'s client reports. The client must never learn who a private individual is from a report. Read each entry and list the exact words that identify a private individual.',
  'List: names of people in any form (full names, first names, surnames, nicknames, possessive or plural forms such as "Kelvin\'s" or "the Etheridges" when they mean a person or family), whether the person is a suspect, offender, member of the public, neighbour, landowner, informant, hunter, contractor, officer or client staff member; and personal contact details (phone numbers, email addresses, home or street addresses, dates of birth, licence or ID numbers).',
  'Do not list: place, forest, block, road, river or hunting-area names (many forest blocks are named after families, such as "Smiths" or "Norris"; treat a word as a place when the entry uses it as a location), company, agency or organisation names (Police, NZTA, DOC), vehicle makes, models, colours and registration plates, species, equipment, job titles, roles or descriptions such as "the offender" or "a hunter".',
  'Think about meaning: "Smiths block" is a place, "Mr Smith" is a person. When unsure whether a word names a person, list it.',
  'Copy each item exactly as it appears in the entry, with the same spelling and capitals. Give full names as one item ("Jordan Nelson"), not separate words.',
  'Return JSON only, with no prose and no code fences, in exactly this shape: {"entries":[{"i":<entry number>,"names":["..."],"details":["..."]}]}. Include only entries that identify someone. Return {"entries":[]} when none do.',
].join('\n');

/** @param {string[]} terms */
export function privacySystemPrompt(terms) {
  const list = terms.slice(0, 400).join('; ');
  return list ? `${PRIVACY_INSTRUCTIONS}\n\nThese are places and organisations in this report, never private individuals: ${list}.` : PRIVACY_INSTRUCTIONS;
}

/** @param {Array<{ fields: Record<string, string> }>} batch */
export function privacyBatchMessage(batch) {
  return `Entries (JSON). "i" is the entry number to use in your answer:\n${JSON.stringify(batch.map((candidate, i) => ({
    i,
    // Each field is sent whole: a digest is recorded for the full wording, so Bob must have read all of it.
    ...candidate.fields,
  })))}`;
}

/** @param {unknown} value */
const items = (value) => (Array.isArray(value) ? value.map(text).filter((item) => item.length >= 2 && item.length <= 120) : []);

/**
 * Bob's findings for one batch, validated. Throws when the answer is not the
 * requested JSON so the next provider is tried.
 * @param {unknown} content
 * @param {number} batchSize
 * @returns {Map<number, { names: string[], details: string[] }>}
 */
export function parsePrivacyFindings(content, batchSize) {
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
  const entries = obj(parsed)?.entries;
  if (!Array.isArray(entries)) throw new Error('model JSON has no entries list');
  /** @type {Map<number, { names: string[], details: string[] }>} */
  const result = new Map();
  for (const entry of entries) {
    const value = obj(entry);
    if (!value) continue;
    const index = typeof value.i === 'number' ? value.i : Number(value.i);
    if (!Number.isInteger(index) || index < 0 || index >= batchSize) continue;
    const names = items(value.names);
    const details = items(value.details);
    if (names.length || details.length) result.set(index, { names, details });
  }
  return result;
}

// A protected name is kept only where it is used as a place: before a place word or after a locating word.
const PLACE_AFTER = /^\s*(?:\(|block|forest|gate|road|rd\b|track|valley|creek|ridge|hut|boundary|area|compartment|station|farm|bridge|landing|skid|cpt\b)/i;
const BLOCK_LETTER_AFTER = /^\s+[A-C]\b/;
const PLACE_BEFORE = /\b(?:at|in|to|from|near|via|into|towards|toward|within|across|around|through|past)\s+$/i;

/**
 * Rewords the text with each finding withheld. A name that is also a
 * protected place or organisation is withheld only where the wording does not
 * use it as a place. Names match whole words, case-insensitively; adjacent
 * withheld markers collapse into one.
 * @param {string} value
 * @param {{ names?: string[], details?: string[] }} findings
 * @param {string[]} [terms]
 */
export function withholdFindings(value, findings, terms = []) {
  if (!value) return value;
  // Only a whole place or organisation is protected: a surname that is also one
  // word of a block name ("Donald" of "Donald Creek") is still withheld.
  const guarded = new Set(terms.map(fold).filter(Boolean));
  const replacements = [
    ...(findings.names ?? []).map((item) => ({ item, marker: NAME_WITHHELD })),
    ...(findings.details ?? []).map((item) => ({ item, marker: DETAILS_WITHHELD })),
  ]
    .filter(({ item }) => item.length >= 2 && item !== NAME_WITHHELD && item !== DETAILS_WITHHELD)
    .sort((left, right) => right.item.length - left.item.length);
  let result = value;
  for (const { item, marker } of replacements) {
    const placeName = marker === NAME_WITHHELD && guarded.has(fold(item));
    const pattern = marker === NAME_WITHHELD
      ? new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(item)}(?![\\p{L}\\p{N}])`, 'giu')
      : new RegExp(escapeRegExp(item), 'gi');
    result = result.replace(pattern, (match, offset, whole) => {
      const after = whole.slice(offset + match.length);
      if (placeName && (PLACE_AFTER.test(after) || BLOCK_LETTER_AFTER.test(after) || PLACE_BEFORE.test(whole.slice(0, offset)))) return match;
      return marker;
    });
  }
  const collapse = new RegExp(`(${escapeRegExp(NAME_WITHHELD)})(\\s+${escapeRegExp(NAME_WITHHELD)})+`, 'g');
  return result.replace(collapse, NAME_WITHHELD);
}

/**
 * The pack's activity lines with Bob's findings applied: reworded lines keep
 * their original content key in lk, and every checked line is marked pv.
 * @param {unknown} activityLines
 * @param {Array<{ indexes: number[], findings: { names: string[], details: string[] } | null }>} checked
 * @param {string[]} terms
 * @returns {{ activityLines: unknown, reworded: number }}
 */
export function applyPrivacyFindings(activityLines, checked, terms) {
  const document = obj(activityLines);
  if (!document || !Array.isArray(document.lines) || !checked.length) return { activityLines, reworded: 0 };
  const lines = [...document.lines];
  let reworded = 0;
  for (const { indexes, findings } of checked) {
    for (const index of indexes) {
      const line = obj(lines[index]);
      if (!line) continue;
      const next = { ...line, pv: PRIVACY_VERSION };
      if (findings) {
        let changed = false;
        for (const field of LINE_TEXT_FIELDS) {
          const original = text(line[field]);
          if (!original) continue;
          const updated = withholdFindings(original, findings, terms);
          if (updated !== original) {
            next[field] = updated;
            changed = true;
          }
        }
        if (changed) {
          next.lk = activityLineKey(line);
          reworded += 1;
        }
      }
      lines[index] = next;
    }
  }
  return { activityLines: { ...document, lines }, reworded };
}

/**
 * Whether Bob's privacy check covers everything the client will read: every
 * line with wording is checked and the reviewer's current wording is the
 * wording that was checked.
 * @param {unknown} activityLines
 * @param {unknown} editorial
 */
export function privacyStatus(activityLines, editorial) {
  const document = obj(activityLines);
  const pendingLines = privacyCandidates(activityLines).reduce((sum, candidate) => sum + candidate.indexes.length, 0);
  const record = obj(document?.privacy);
  const editorialChecked = text(record?.editorial_digest) === editorialDigest(editorial);
  return { pendingLines, editorialChecked, cleared: pendingLines === 0 && editorialChecked };
}

/**
 * Why a monthly pack may not be rendered or sent yet, or '' when Bob's
 * privacy check has cleared everything the client will read. Custom packs and
 * packs without a frozen activity copy have nothing for the check to store.
 * @param {{ report_kind?: unknown, activity_lines?: unknown, editorial?: unknown } | null | undefined} pack
 */
export function privacyHoldReason(pack) {
  const document = obj(pack?.activity_lines);
  if (!pack || pack.report_kind === 'custom' || !document || !Array.isArray(document.lines)) return '';
  const status = privacyStatus(document, pack.editorial);
  if (status.cleared) return '';
  return status.pendingLines > 0
    ? `Run Bob's privacy check first: ${status.pendingLines} ${status.pendingLines === 1 ? 'entry has' : 'entries have'} not been checked for personal names`
    : "Run Bob's privacy check first: the report wording has changed since it was last checked for personal names";
}
