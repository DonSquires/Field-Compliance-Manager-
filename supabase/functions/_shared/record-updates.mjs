// In-app Bob turns facts a user gives him (for example a council email) into governed record updates.
// Owner request 2026-10: in-app Bob must be agentic across the app and update people, vehicles and reports
// from what he is told, instead of answering that he has no write path.
// Every write is an existing audited RPC called with the caller's own JWT, so the database enforces the
// caller's rank and tenant scope. Nothing is written until the caller confirms the preview in the next
// chat turn. Anything with no governed path is held and reported plainly; it is never claimed as done.
// This module is pure (no Deno or Node globals beyond Web Crypto) so Node tests can import it.

export const RECORD_UPDATE_TTL_MS = 30 * 60 * 1000;
export const RECORD_UPDATE_MAX_OPERATIONS = 25;
// Leaves room inside the 150 s edge budget to persist receipts for whatever did run.
export const RECORD_UPDATE_APPLY_BUDGET_MS = 90_000;

export const SAFETY_HAZARD_CLASSES = Object.freeze([
  'violence_or_aggression', 'weapons', 'dangerous_dog', 'hazardous_substances',
  'unsafe_structure_or_ground', 'vehicle_defect', 'medical_or_welfare', 'other',
]);
const HAZARD_LABELS = {
  violence_or_aggression: 'violence or aggression', weapons: 'weapons', dangerous_dog: 'dangerous dog',
  hazardous_substances: 'hazardous substances', unsafe_structure_or_ground: 'unsafe structure or ground',
  vehicle_defect: 'vehicle defect', medical_or_welfare: 'medical or welfare', other: 'other hazard',
};
const ALERT_LEVELS = ['low', 'medium', 'high', 'critical'];
const ALIAS_KINDS = ['aka', 'preferred_name', 'legal_name', 'previous_name', 'maiden_name', 'nickname'];
const ALIAS_LABELS = {
  aka: 'another name', preferred_name: 'preferred name', legal_name: 'legal name',
  previous_name: 'previous name', maiden_name: 'maiden name', nickname: 'nickname',
};
const LINK_RELATIONSHIPS = ['associated_person', 'driver', 'owner'];
const RELATIONSHIP_LABELS = { associated_person: 'an associated person', driver: 'a driver', owner: 'the owner' };
// nzta_mvr is reserved for the governed MVR import; a chat message is never the register.
const LINK_SOURCES = ['officer_observed', 'owner_declared', 'other'];
const SOURCE_LABELS = { officer_observed: 'officer observed', owner_declared: 'owner declared', other: 'supplied information' };
const RECORD_KINDS = ['observation', 'location_event'];
const RECORD_KIND_LABELS = { observation: 'observation report', location_event: 'patrol/location event' };
const ENTRY_KINDS = ['note', 'follow_up_requested', 'follow_up_resolved', 'hs_concern'];
const ENTRY_LABELS = { note: 'note', follow_up_requested: 'follow-up request', follow_up_resolved: 'follow-up resolution', hs_concern: 'safety concern' };
const VEHICLE_TEXT_FIELDS = ['make', 'model', 'colour', 'body_type'];
const VEHICLE_DATE_FIELDS = ['rego_expiry', 'wof_expiry', 'cof_expiry'];
const TARGET_TYPES = ['person', 'vehicle', 'site', 'place'];
// Person details go through the identity registry's audited administrator path (record_identity_person_details).
// Licence numbers and addresses stay with the registry screen; chat records only what officers usually relay.
const PERSON_TEXT_FIELDS = { category: 120, notes: 1000 };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Confirmed person steps go through one audited database operation: create is serialised per organisation and
// name (returning a person recorded meanwhile), update changes details only and never the name.
const PERSON_DETAILS_RPC = 'record_identity_person_details';
const STEP_KINDS = ['create_person', 'update_person_details', 'register_vehicle', 'update_vehicle_details', 'vehicle_person_link', 'person_alias', 'safety_warning', 'record_note'];
// Person-creating links resolve before facts about that person, whatever order they were given in.
const RESOLVE_ORDER = { person_details: 0, vehicle_details: 1, vehicle_person_link: 2, person_alias: 3, safety_warning: 4, record_note: 5 };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXACT_MATCH_BASES = new Set(['name_exact', 'alias_exact']);

const isUuid = (value) => typeof value === 'string' && UUID_RE.test(value);
const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function text(value, max) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\s+/g, ' ').trim().slice(0, max);
}

function quote(value, max = 160) {
  const t = text(value, max + 1);
  return `"${t.length > max ? `${t.slice(0, max)}…` : t}"`;
}

// Mirrors public.normalize_plate_number: upper-case alphanumerics only. The registers cap plates at 10.
export function normalisePlate(value) {
  const plate = String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return plate.length >= 1 && plate.length <= 10 ? plate : null;
}

// Only case and spacing are folded: "Māia" and "Maia" may be different people, so they resolve separately and
// are treated as one person only if the register binds both to the same record.
function personKey(name) {
  return String(name ?? '').normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function normalisePerson(raw) {
  if (typeof raw === 'string') raw = { name: raw };
  if (!isObject(raw)) return null;
  const id = isUuid(raw.person_record_id) ? raw.person_record_id.toLowerCase() : null;
  const name = text(raw.name ?? raw.display_name, 120);
  if (!id && !name) return null;
  return { name: name || null, person_record_id: id, ref: id ? `id:${id}` : `name:${personKey(name)}` };
}

function vehicleFields(raw) {
  const fields = {};
  if (!isObject(raw)) return { fields, problems: [] };
  const problems = [];
  for (const key of VEHICLE_TEXT_FIELDS) {
    const value = text(raw[key], 101);
    if (!value) continue;
    if (value.length > 100) problems.push(`${key} is longer than 100 characters`);
    else fields[key] = value;
  }
  if (raw.year !== undefined && raw.year !== null && raw.year !== '') {
    const year = Number(raw.year);
    const max = new Date().getUTCFullYear() + 1;
    if (Number.isInteger(year) && year >= 1886 && year <= max) fields.year = year;
    else problems.push('year is not a valid vehicle year');
  }
  for (const key of VEHICLE_DATE_FIELDS) {
    const value = text(raw[key], 20);
    if (!value) continue;
    if (/^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))) fields[key] = value;
    else problems.push(`${key} must be a date (YYYY-MM-DD)`);
  }
  return { fields, problems };
}

function personFields(raw) {
  const fields = {};
  if (!isObject(raw)) return { fields, problems: [] };
  const problems = [];
  for (const [key, max] of Object.entries(PERSON_TEXT_FIELDS)) {
    const value = text(raw[key], max + 1);
    if (!value) continue;
    if (value.length > max) problems.push(`${key} is longer than ${max} characters`);
    else fields[key] = value;
  }
  const email = text(raw.email, 255);
  if (email) {
    if (email.length <= 254 && EMAIL_RE.test(email)) fields.email = email;
    else problems.push('email is not a valid address');
  }
  const phone = text(raw.phone, 41);
  if (phone) {
    if (phone.length <= 40 && phone.replace(/\D/g, '').length >= 7) fields.phone = phone;
    else problems.push('phone is not a valid number');
  }
  const dob = text(raw.date_of_birth, 20);
  if (dob) {
    const valid = /^\d{4}-\d{2}-\d{2}$/.test(dob) && !Number.isNaN(Date.parse(`${dob}T00:00:00Z`)) && dob <= new Date().toISOString().slice(0, 10);
    if (valid) fields.date_of_birth = dob;
    else problems.push('date_of_birth must be a past date (YYYY-MM-DD)');
  }
  return { fields, problems };
}

function describeFields(fields) {
  return Object.entries(fields).map(([key, value]) => `${key.replace(/_/g, ' ')} ${value}`).join(', ');
}

function normaliseOperation(raw, index, planSummary) {
  const hold = (reason) => ({ held: { index, statement: text(raw?.statement ?? raw?.kind ?? 'update', 200), reason } });
  if (!isObject(raw)) return hold('This item was not a structured update.');
  // Each operation keeps the source it came from, so an amended plan audits carried items against their own source.
  const sourceSummary = text(raw.source_summary, 240) || planSummary || undefined;
  const result = normaliseOperationBody(raw, index, sourceSummary, hold);
  if (result.op && sourceSummary) result.op.source_summary = sourceSummary;
  return result;
}

function normaliseOperationBody(raw, index, sourceSummary, hold) {
  const kind = text(raw.kind, 40);
  switch (kind) {
    case 'person_details': {
      const person = normalisePerson(raw.person);
      if (!person?.name) return hold('Give the person\'s name as it should be recorded.');
      const { fields, problems } = personFields(raw.fields);
      if (problems.length) return hold(`${person.name}: ${problems.join('; ')}.`);
      return { op: { index, kind, person, fields, confirm_new_person: raw.confirm_new_person === true } };
    }
    case 'vehicle_details': {
      const plate = normalisePlate(raw.plate);
      if (!plate) return hold('A valid registration plate is needed to update vehicle details.');
      const { fields, problems } = vehicleFields(raw.fields);
      if (problems.length) return hold(`Vehicle ${plate}: ${problems.join('; ')}.`);
      if (!Object.keys(fields).length) return hold(`No vehicle details were given for ${plate}.`);
      return { op: { index, kind, plate, fields } };
    }
    case 'vehicle_person_link': {
      const plate = normalisePlate(raw.plate);
      if (!plate) return hold('A valid registration plate is needed to link a person to a vehicle.');
      const person = normalisePerson(raw.person);
      if (!person) return hold(`A person's name is needed to link them to ${plate}.`);
      const relationship = raw.relationship ? text(raw.relationship, 40) : 'associated_person';
      if (!LINK_RELATIONSHIPS.includes(relationship)) return hold(`Choose how the person relates to ${plate}: associated person, driver or owner.`);
      const source = raw.source ? text(raw.source, 40) : 'other';
      if (!LINK_SOURCES.includes(source)) return hold('Chat information can be recorded as officer observed, owner declared or other supplied information; the NZTA register is only loaded through its governed import.');
      const basis = text(raw.basis, 300) || sourceSummary || 'Information supplied by the user in Bob chat';
      return { op: { index, kind, plate, person, relationship, source, basis } };
    }
    case 'person_alias': {
      const person = normalisePerson(raw.person);
      if (!person) return hold('Say which person the other name belongs to.');
      const alias = text(raw.alias, 120);
      if (!alias) return hold('The other name to record is missing.');
      const aliasKind = raw.alias_kind ? text(raw.alias_kind, 40) : 'aka';
      if (!ALIAS_KINDS.includes(aliasKind)) return hold(`Choose what kind of name ${quote(alias, 60)} is (another name, preferred, legal, previous, maiden or nickname).`);
      return { op: { index, kind, person, alias, alias_kind: aliasKind, notes: text(raw.notes, 300) || null } };
    }
    case 'safety_warning': {
      const target = isObject(raw.target) ? raw.target : {};
      const type = text(target.type, 20);
      if (!TARGET_TYPES.includes(type)) return hold('A safety warning needs a person, vehicle, site or place to attach to.');
      let resolvedTarget;
      if (type === 'person') {
        const person = normalisePerson(target);
        if (!person) return hold('Say which person the safety warning is about.');
        resolvedTarget = { type, person };
      } else if (type === 'vehicle') {
        const plate = normalisePlate(target.plate);
        if (!plate) return hold('A valid registration plate is needed for a vehicle safety warning.');
        resolvedTarget = { type, plate };
      } else {
        const id = type === 'site' ? target.site_id : target.place_id;
        if (!isUuid(id)) return hold(`A safety warning on a ${type} needs that ${type}'s record id; tell me which ${type} it is.`);
        resolvedTarget = { type, id: id.toLowerCase(), name: text(target.name, 120) || null };
      }
      const hazardClass = raw.hazard_class ? text(raw.hazard_class, 40) : 'other';
      if (!SAFETY_HAZARD_CLASSES.includes(hazardClass)) return hold(`Choose a hazard class: ${SAFETY_HAZARD_CLASSES.join(', ')}.`);
      const alertLevel = raw.alert_level ? text(raw.alert_level, 20) : 'medium';
      if (!ALERT_LEVELS.includes(alertLevel)) return hold('Choose a severity: low, medium, high or critical.');
      const note = text(raw.note, 1000);
      if (note.length < 5) return hold('A safety warning needs a short note of what to expect.');
      return { op: { index, kind, target: resolvedTarget, hazard_class: hazardClass, alert_level: alertLevel, note } };
    }
    case 'record_note': {
      const recordKind = text(raw.record_kind, 40);
      if (!RECORD_KINDS.includes(recordKind)) return hold('Notes can be added to an observation report or a patrol/location event.');
      if (!isUuid(raw.record_id)) return hold('Tell me which report record this note belongs to (its record id).');
      const entryKind = raw.entry_kind ? text(raw.entry_kind, 40) : 'note';
      if (!ENTRY_KINDS.includes(entryKind)) return hold('Choose the update type: note, follow-up request, follow-up resolution or safety concern.');
      const body = String(raw.body ?? '').trim();
      if (!body || body.length > 4000) return hold('The note must be between 1 and 4000 characters.');
      return { op: { index, kind, record_kind: recordKind, record_id: raw.record_id.toLowerCase(), entry_kind: entryKind, body } };
    }
    case 'unsupported':
      return { held: { index, statement: text(raw.statement, 200) || 'update', reason: text(raw.reason, 300) || 'There is no governed way to record this yet.' } };
    default:
      return hold(`There is no governed way for me to apply a "${kind || 'unknown'}" update yet.`);
  }
}

/**
 * @typedef {{ ok: boolean, error?: string, amended?: boolean, plan?: { source_summary: string, operations: any[], held: any[] } }} RecordUpdatePlanResult
 */

/** @returns {RecordUpdatePlanResult} */
export function validateRecordUpdatePlan(args) {
  const source = isObject(args) ? args : {};
  const sourceSummary = text(source.source_summary, 240);
  const raw = Array.isArray(source.operations) ? source.operations : [];
  if (!raw.length) return { ok: false, error: 'Tell me what should change: list each person, vehicle or report update.' };
  if (raw.length > RECORD_UPDATE_MAX_OPERATIONS) {
    return { ok: false, error: `That is more than ${RECORD_UPDATE_MAX_OPERATIONS} updates at once; split it into smaller batches.` };
  }
  const operations = [];
  const held = [];
  raw.forEach((item, index) => {
    const result = normaliseOperation(item, index, sourceSummary);
    if (result.op) operations.push(result.op);
    else held.push(result.held);
  });
  return { ok: true, plan: { source_summary: sourceSummary, operations, held } };
}

const compact = (value) => Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null && v !== undefined && v !== ''));
const personSource = (person) => compact({ name: person.name, person_record_id: person.person_record_id });

// The validated operation in the tool's input shape, so a later amendment can re-validate and re-resolve it.
function toSourceOperation(op) {
  const source = sourceShape(op);
  return source && op.source_summary ? { ...source, source_summary: op.source_summary } : source;
}

function sourceShape(op) {
  switch (op.kind) {
    case 'person_details': return compact({ kind: op.kind, person: personSource(op.person), fields: op.fields, confirm_new_person: op.confirm_new_person || undefined });
    case 'vehicle_details': return { kind: op.kind, plate: op.plate, fields: op.fields };
    case 'vehicle_person_link': return { kind: op.kind, plate: op.plate, person: personSource(op.person), relationship: op.relationship, source: op.source, basis: op.basis };
    case 'person_alias': return compact({ kind: op.kind, person: personSource(op.person), alias: op.alias, alias_kind: op.alias_kind, notes: op.notes });
    case 'safety_warning': {
      const t = op.target;
      const target = t.type === 'person' ? { type: 'person', ...personSource(t.person) }
        : t.type === 'vehicle' ? { type: 'vehicle', plate: t.plate }
          : compact({ type: t.type, [t.type === 'site' ? 'site_id' : 'place_id']: t.id, name: t.name });
      return { kind: op.kind, target, hazard_class: op.hazard_class, alert_level: op.alert_level, note: op.note };
    }
    case 'record_note': return { kind: op.kind, record_kind: op.record_kind, record_id: op.record_id, entry_kind: op.entry_kind, body: op.body };
    default: return null;
  }
}

/**
 * Every item of a validated plan, by position, in input shape. Held items keep their wording and the kind they
 * were asked as, so an amendment that supplies a proper operation of that kind replaces them.
 * @param {{ operations: any[], held: any[] }} plan
 * @param {any[]} [rawOperations]
 */
export function recordUpdateSources(plan, rawOperations = []) {
  const byIndex = new Map();
  for (const op of plan.operations) byIndex.set(op.index, toSourceOperation(op));
  for (const item of plan.held) {
    if (byIndex.has(item.index)) continue;
    byIndex.set(item.index, compact({
      kind: 'unsupported', statement: item.statement, reason: item.reason,
      original_kind: item.original_kind ?? (text(rawOperations[item.index]?.kind, 40) || null),
      subject: item.subject ?? rawSubject(rawOperations[item.index]),
    }));
  }
  return [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, source]) => source);
}

// What an item is about (vehicle, person, site or place, report record), from a validated operation or from a raw
// one that was held, so a held item is superseded only by a valid operation about the same thing. An item with no
// subject is never superseded automatically: it stays until the user drops it.
function subjectOf(...parts) {
  return parts.filter(Boolean).join('|') || null;
}
function opSubject(op) {
  const t = op.target;
  return subjectOf(
    op.plate ?? (t?.type === 'vehicle' ? t.plate : null),
    (op.person ?? (t?.type === 'person' ? t.person : null))?.ref,
    t && (t.type === 'site' || t.type === 'place') ? `${t.type}:${t.id}` : null,
    op.record_id ? `record:${op.record_id}` : null,
  );
}
function rawSubject(raw) {
  if (!isObject(raw)) return null;
  const target = isObject(raw.target) ? raw.target : {};
  const placeId = target.type === 'site' ? target.site_id : target.type === 'place' ? target.place_id : null;
  return subjectOf(
    normalisePlate(raw.plate ?? target.plate),
    normalisePerson(raw.person ?? (target.type === 'person' ? target : null))?.ref,
    isUuid(placeId) ? `${target.type}:${placeId.toLowerCase()}` : null,
    isUuid(raw.record_id) ? `record:${raw.record_id.toLowerCase()}` : null,
  );
}

function operationKey(op) {
  switch (op.kind) {
    case 'person_details': return `person:${op.person.ref}`;
    case 'vehicle_details': return `vehicle:${op.plate}`;
    case 'vehicle_person_link': return `link:${op.plate}:${op.person.ref}`;
    case 'person_alias': return `alias:${op.person.ref}:${personKey(op.alias)}`;
    case 'safety_warning': {
      const t = op.target;
      const target = t.type === 'person' ? t.person.ref : t.type === 'vehicle' ? t.plate : `${t.type}:${t.id}`;
      return `warning:${target}:${op.hazard_class}`;
    }
    case 'record_note': return `note:${op.record_id}:${op.entry_kind}:${personKey(op.body)}`;
    default: return `other:${op.index}`;
  }
}

function joinSummaries(values) {
  const unique = [...new Set(values.map((value) => text(value, 240)).filter(Boolean))];
  return unique.length ? text(unique.join('; '), 240) : undefined;
}

function mergeOperation(previous, next) {
  const sourceSummary = joinSummaries([previous.source_summary, next.source_summary]);
  if (next.kind === 'vehicle_details') return { ...next, fields: { ...previous.fields, ...next.fields }, source_summary: sourceSummary };
  if (next.kind === 'person_details') {
    return {
      ...next, fields: { ...previous.fields, ...next.fields },
      confirm_new_person: previous.confirm_new_person || next.confirm_new_person, source_summary: sourceSummary,
    };
  }
  return next;
}

const LIST_MARKER = /^\s*(?:[-*•]|\d+[.)])\s+/;
// Wording copied from a preview line, with its list marker, case, spacing and closing punctuation folded away.
function removalText(value) {
  return personKey(String(value ?? '').replace(LIST_MARKER, '').replace(/[\u201c\u201d]/g, '"')).replace(/[\s.;,]+$/, '');
}

// Every source operation a preview step was built from (one person step can carry several detail items).
function stepSourceIndexes(step) {
  const indexes = Array.isArray(step?.op_indexes) ? step.op_indexes : [step?.op_index];
  return indexes.filter(Number.isInteger);
}

// Preview item numbers, or wording copied from one preview line, name the items to drop. Wording must identify
// exactly one line: wording that fits several is refused, so nothing is dropped that the user did not mean.
function removalIndexes(remove, prior) {
  const steps = Array.isArray(prior.steps) ? prior.steps : [];
  const held = Array.isArray(prior.held) ? prior.held : [];
  const lines = [
    ...steps.map((step) => ({ texts: [step.label], indexes: stepSourceIndexes(step) })),
    ...held.map((item) => ({ texts: [`${item.statement ?? ''}: ${item.reason ?? ''}`, item.statement, item.reason], indexes: [item.index].filter(Number.isInteger) })),
  ].filter((line) => line.indexes.length).map((line) => ({ ...line, texts: line.texts.map(removalText).filter(Boolean) }));
  const indexes = new Set();
  const unmatched = [];
  const ambiguous = [];
  for (const entry of Array.isArray(remove) ? remove.slice(0, RECORD_UPDATE_MAX_OPERATIONS * 2) : []) {
    const number = typeof entry === 'number' ? entry : /^\s*\d+\s*$/.test(String(entry)) ? Number(entry) : null;
    if (number !== null) {
      const found = stepSourceIndexes(steps[number - 1]);
      if (found.length) found.forEach((index) => indexes.add(index));
      else unmatched.push(String(entry));
      continue;
    }
    const wanted = removalText(text(entry, 4000));
    if (wanted.length < 3) { unmatched.push(text(entry, 80)); continue; }
    const exact = lines.filter((line) => line.texts.includes(wanted));
    const hits = exact.length ? exact : lines.filter((line) => line.texts.some((candidate) => candidate.includes(wanted)));
    if (hits.length === 1) hits[0].indexes.forEach((index) => indexes.add(index));
    else if (hits.length) ambiguous.push(text(entry, 80));
    else unmatched.push(text(entry, 80));
  }
  return { indexes, unmatched, ambiguous };
}

// A corrected name or plate moves every carried item about it (details, links, other names, warnings, held items)
// to the corrected value, so the earlier spelling is not written alongside the corrected one.
function applyCorrections(sources, corrections) {
  const list = Array.isArray(corrections) ? corrections.slice(0, RECORD_UPDATE_MAX_OPERATIONS) : [];
  if (!list.length) return { sources };
  const people = new Map();
  const plates = new Map();
  for (const raw of list) {
    if (isObject(raw) && raw.kind === 'plate') {
      const from = normalisePlate(raw.from);
      const to = normalisePlate(raw.to);
      if (!from || !to) return { error: 'A plate correction needs the plate as previewed and the corrected plate.' };
      plates.set(from, { to, label: from });
    } else {
      const label = text(isObject(raw) ? raw.from : null, 120);
      const to = text(isObject(raw) ? raw.to : null, 120);
      if (!label || !to) return { error: 'A name correction needs the name as previewed and the corrected name.' };
      people.set(personKey(label), { to, label });
    }
  }
  const used = new Set();
  const fixPerson = (person) => {
    if (!isObject(person) || typeof person.name !== 'string') return person;
    const key = personKey(person.name);
    if (!people.has(key)) return person;
    used.add(`person:${key}`);
    // A different name is a different lookup, so a record id chosen for the earlier name is not carried over.
    const { person_record_id: _dropped, ...rest } = person;
    return { ...rest, name: people.get(key).to };
  };
  const fixPlate = (plate) => {
    const key = normalisePlate(plate);
    if (!key || !plates.has(key)) return plate;
    used.add(`plate:${key}`);
    return plates.get(key).to;
  };
  const fixSubject = (subject) => (typeof subject !== 'string' ? subject : subject.split('|').map((part) => {
    if (part.startsWith('name:') && people.has(part.slice(5))) {
      used.add(`person:${part.slice(5)}`);
      return `name:${personKey(people.get(part.slice(5)).to)}`;
    }
    if (plates.has(part)) {
      used.add(`plate:${part}`);
      return plates.get(part).to;
    }
    return part;
  }).join('|'));
  const corrected = sources.map((source) => {
    if (!isObject(source)) return source;
    const next = { ...source };
    if (next.person) next.person = fixPerson(next.person);
    if (next.plate) next.plate = fixPlate(next.plate);
    if (isObject(next.target)) {
      if (next.target.type === 'person') next.target = fixPerson(next.target);
      else if (next.target.type === 'vehicle') next.target = { ...next.target, plate: fixPlate(next.target.plate) };
    }
    if (next.subject) next.subject = fixSubject(next.subject);
    return next;
  });
  const missing = [
    ...[...people.entries()].filter(([key]) => !used.has(`person:${key}`)).map(([, value]) => value.label),
    ...[...plates.entries()].filter(([key]) => !used.has(`plate:${key}`)).map(([, value]) => value.label),
  ];
  if (missing.length) {
    return { error: `I could not find ${missing.map((value) => quote(value, 60)).join(', ')} in the preview, so I have not changed it. Tell me the name or plate exactly as the preview shows it.` };
  }
  return { sources: corrected };
}

const heldIdentity = (entry) => [entry.original_kind ?? '', entry.subject ?? '', personKey(entry.held.statement), personKey(entry.held.reason)].join('\u0000');

/**
 * Applies a follow-up update_records call to the preview that is waiting for a yes: the new operations are added,
 * an item about the same vehicle, person, link, name, warning or note replaces (details merge into) the earlier one,
 * `corrections` move carried items to a corrected name or plate, and `remove` drops preview items. The result is a
 * complete plan that must be previewed and confirmed again.
 * @param {any} prior a verified pending preview carrying source_operations
 * @param {any} args the planner's update_records arguments
 * @returns {RecordUpdatePlanResult}
 */
export function amendRecordUpdatePlan(prior, args) {
  const source = isObject(args) ? args : {};
  const incomingRaw = Array.isArray(source.operations) ? source.operations : [];
  const removing = Array.isArray(source.remove) && source.remove.length > 0;
  const correcting = Array.isArray(source.corrections) && source.corrections.length > 0;
  if (!incomingRaw.length && !removing && !correcting) {
    return { ok: false, error: 'Tell me what to change in the preview: what to add or correct, or which numbered item to drop.' };
  }
  const { indexes: dropped, unmatched, ambiguous } = removalIndexes(source.remove, prior);
  if (ambiguous.length) {
    return { ok: false, error: `${ambiguous.map((u) => quote(u, 60)).join(', ')} matches more than one item in the preview, so I have not changed it. Tell me the number of the item to drop, or copy its whole line.` };
  }
  if (unmatched.length) {
    return { ok: false, error: `I could not find ${unmatched.map((u) => quote(u, 60)).join(', ')} in the preview, so I have not changed it. Tell me the number of the item to drop.` };
  }
  const correction = applyCorrections(Array.isArray(prior?.source_operations) ? prior.source_operations : [], source.corrections);
  if (correction.error) return { ok: false, error: correction.error };
  const sources = correction.sources;
  const base = sources.length ? validateRecordUpdatePlan({ source_summary: prior.source_summary, operations: sources }) : { ok: true, plan: { source_summary: '', operations: [], held: [] } };
  const incoming = incomingRaw.length ? validateRecordUpdatePlan(source) : { ok: true, plan: { source_summary: '', operations: [], held: [] } };
  if (!base.ok) return base;
  if (!incoming.ok) return incoming;

  const entries = [];
  for (const op of base.plan.operations) if (!dropped.has(op.index)) entries.push({ key: operationKey(op), op });
  for (const item of base.plan.held) {
    if (dropped.has(item.index)) continue;
    entries.push({ held: item, carried: true, original_kind: text(sources[item.index]?.original_kind, 40) || null, subject: text(sources[item.index]?.subject, 300) || null });
  }
  for (const op of incoming.plan.operations) {
    const key = operationKey(op);
    const existing = entries.find((entry) => entry.op && entry.key === key);
    if (existing) existing.op = mergeOperation(existing.op, op);
    else entries.push({ key, op });
  }
  // Every new held item is listed in its own right; only the same held line sent again is not listed twice.
  for (const item of incoming.plan.held) {
    const entry = { held: item, carried: false, original_kind: text(incomingRaw[item.index]?.kind, 40) || null, subject: rawSubject(incomingRaw[item.index]) };
    if (!entries.some((other) => other.held && other.carried && heldIdentity(other) === heldIdentity(entry))) entries.push(entry);
  }
  // An earlier item held for a problem is superseded once the amendment supplies a valid operation of that kind
  // about the same vehicle, person, site, place or report. Items with no subject wait for the user to drop them.
  const supplied = new Set(incoming.plan.operations.map((op) => { const subject = opSubject(op); return subject ? `${op.kind}#${subject}` : null; }).filter(Boolean));
  const kept = entries.filter((entry) => !(entry.held && entry.carried && entry.original_kind && entry.subject && supplied.has(`${entry.original_kind}#${entry.subject}`)));
  if (kept.length > RECORD_UPDATE_MAX_OPERATIONS) {
    return { ok: false, error: `With those changes the preview would hold more than ${RECORD_UPDATE_MAX_OPERATIONS} updates. Reply yes to apply the current preview first, or no to discard it, then send the rest.` };
  }
  const operations = [];
  const held = [];
  kept.forEach((entry, index) => {
    if (entry.op) operations.push({ ...entry.op, index });
    else held.push(compact({ ...entry.held, index, original_kind: entry.original_kind, subject: entry.subject }));
  });
  return {
    ok: true,
    amended: true,
    plan: { source_summary: incoming.plan.source_summary || text(prior.source_summary, 240), operations, held },
  };
}

function errorMessage(error) {
  const message = typeof error === 'string' ? error : error?.message ?? 'unknown error';
  return text(message, 240);
}

async function call(rpc, name, args) {
  try {
    const result = await rpc(name, args);
    return { data: result?.data ?? null, error: result?.error ?? null };
  } catch (error) {
    return { data: null, error };
  }
}

async function lookupPlate(rpc, plate) {
  const { data, error } = await call(rpc, 'search_vehicle_registrations', { p_pattern: plate, p_limit: 5 });
  if (error) return { error: errorMessage(error) };
  const row = (Array.isArray(data) ? data : []).find((r) => normalisePlate(r?.plate_number) === plate);
  if (!row) return { vehicle_id: null, seen: false };
  return { vehicle_id: isUuid(row.id) ? row.id : null, seen: true };
}

function personLookupProblem(message) {
  return /42501|access|permission|authori[sz]/i.test(message)
    ? 'You do not have person-search access, so I cannot match this person.'
    : `I could not search for this person (${message}).`;
}

const matchBasis = (row) => String(row?.match_basis ?? '').replace(/\+date_of_birth$/, '');
const sameRecord = (row, id) => String(row?.person_record_id ?? '').toLowerCase() === id;

// Dates of birth the register holds for exact-name records, so a supplied date can tell a namesake from the person
// already recorded. Administrator-only, like every person-details write that supplies a date of birth.
async function registryBirthDates(rpc, organizationId, rows) {
  const dates = new Map();
  for (const name of [...new Set(rows.map((row) => text(row.display_name, 120)).filter(Boolean))]) {
    const { data, error } = await call(rpc, 'get_identity_registry', { p_organization_id: organizationId, p_search: name, p_limit: 25 });
    if (error || !isObject(data) || !Array.isArray(data.people)) return { error: error ? errorMessage(error) : 'the register returned no people' };
    for (const person of data.people) {
      if (!isUuid(person?.person_record_id)) continue;
      dates.set(person.person_record_id.toLowerCase(), text(person.date_of_birth, 10) || null);
    }
  }
  return { dates };
}

/**
 * Matches a named person in the caller's organisation through find_person_matches (the register's own scoring).
 * Exact name or active alias matches bind; a supplied date of birth separates namesakes; every other candidate the
 * register returns (spelling variants score 0.72, similar names at most 0.80) holds a create until the user says
 * who it is, exactly as the register screen asks "is this one of these people?". confirmNew records that the user
 * said this is a different person from everyone returned.
 */
async function lookupPerson(rpc, organizationId, name, { dateOfBirth = null, confirmNew = false } = {}) {
  const args = { p_organization_id: organizationId, p_name: name, p_limit: 8 };
  if (dateOfBirth) args.p_date_of_birth = dateOfBirth;
  const { data, error } = await call(rpc, 'find_person_matches', args);
  if (error) return { state: 'error', reason: personLookupProblem(errorMessage(error)) };
  const rows = (Array.isArray(data) ? data : []).filter((row) => isUuid(row?.person_record_id));
  const ids = (list) => [...new Set(list.map((row) => row.person_record_id.toLowerCase()))];
  if (confirmNew) return { state: 'new', close: [], distinct_from: ids(rows), confirmed_distinct: rows.length > 0 };
  const exact = rows.filter((row) => EXACT_MATCH_BASES.has(matchBasis(row)));
  const exactIds = ids(exact);
  const bound = (id) => ({ state: 'bound', person_record_id: id, display_name: text(exact.find((row) => sameRecord(row, id))?.display_name, 120) || name });
  const closeNames = (list) => [...new Set(list.map((row) => text(row.display_name, 120)).filter(Boolean))].slice(0, 3);
  const others = rows.filter((row) => !EXACT_MATCH_BASES.has(matchBasis(row)));
  if (!exactIds.length) return { state: 'new', similar: rows.length, close: closeNames(rows), distinct_from: [] };
  if (!dateOfBirth) return exactIds.length === 1 ? bound(exactIds[0]) : { state: 'ambiguous', count: exactIds.length };
  // The search itself confirms a stored profile date of birth; with one namesake that settles it.
  if (exactIds.length === 1 && exact.some((row) => /\+date_of_birth$/.test(String(row.match_basis ?? '')))) return bound(exactIds[0]);
  const registry = await registryBirthDates(rpc, organizationId, exact);
  if (registry.error) {
    return { state: 'error', reason: /42501|administrator|access|permission/i.test(registry.error)
      ? `Only identity-register administrators can compare dates of birth, so I cannot tell whether ${quote(name, 80)} is the person already recorded.`
      : `I could not compare dates of birth for ${quote(name, 80)} (${registry.error}).` };
  }
  if (exactIds.some((id) => !registry.dates.has(id))) {
    return { state: 'error', reason: `I could not read the recorded date of birth for everyone named ${quote(name, 80)}, so I cannot tell whether this is the same person.` };
  }
  const same = exactIds.filter((id) => registry.dates.get(id) === dateOfBirth);
  const undated = exactIds.filter((id) => registry.dates.get(id) === null);
  if (same.length === 1) return bound(same[0]);
  if (same.length > 1) return { state: 'ambiguous', count: same.length };
  // Someone recorded without a date of birth may be this person; someone with a different one is not.
  if (undated.length === 1) return bound(undated[0]);
  if (undated.length > 1) return { state: 'ambiguous', count: undated.length };
  return { state: 'new', similar: rows.length, close: closeNames(others), distinct_from: exactIds, different_birth_date: true };
}

// A planner-supplied record id is never trusted on its own: it must come back from the caller's own person
// search for the given name, and the preview then shows the stored name rather than the planner's wording.
async function lookupPersonById(rpc, organizationId, person) {
  if (!person.name) {
    return { state: 'error', reason: 'Tell me the person\'s name as recorded so I can confirm that person record before changing it.' };
  }
  const { data, error } = await call(rpc, 'find_person_matches', { p_organization_id: organizationId, p_name: person.name, p_limit: 8 });
  if (error) return { state: 'error', reason: personLookupProblem(errorMessage(error)) };
  const row = (Array.isArray(data) ? data : [])
    .find((r) => typeof r?.person_record_id === 'string' && r.person_record_id.toLowerCase() === person.person_record_id);
  if (!row) {
    return { state: 'error', reason: `That person record does not match ${quote(person.name, 80)} in your organisation, so I have not used it; tell me which person you mean.` };
  }
  return { state: 'bound', person_record_id: person.person_record_id, display_name: text(row.display_name, 120) || person.name };
}

async function lookupCanonicalPerson(rpc, organizationId, personRecordId, name) {
  const { data, error } = await call(rpc, 'get_identity_registry', { p_organization_id: organizationId, p_search: name, p_limit: 25 });
  if (error || !isObject(data) || !Array.isArray(data.people)) return null;
  const row = data.people.find((p) => p?.person_record_id === personRecordId && isUuid(p?.canonical_person_id));
  return row ? row.canonical_person_id : null;
}

function personLabel(state, person) {
  if (state?.state === 'bound') return `${state.display_name} (existing person record)`;
  return `${person.name ?? 'this person'} (new person record)`;
}

function personStepLabel(step) {
  const details = Object.keys(step.fields).length ? ` with ${describeFields(step.fields)}` : '';
  const why = step.confirmed_distinct
    ? ' — you confirmed this is a different person from the similar record already on file'
    : step.different_birth_date
      ? ' — someone with this name is already recorded with a different date of birth, so this is a separate record'
      : '';
  return step.kind === 'create_person'
    ? `Create a person record for ${step.display_name} in your organisation's identity register${details}${why} (identity-register administrators only)`
    : `Update ${step.display_name} (existing person record)${details}; other details on the record stay as they are (identity-register administrators only)`;
}

// What the user said about each named person across the whole request: a date of birth separates namesakes, and
// confirm_new_person says they are not anyone already recorded.
function personHints(operations) {
  const hints = new Map();
  for (const op of operations) {
    if (op.kind !== 'person_details' || op.person.person_record_id) continue;
    const hint = hints.get(op.person.ref) ?? { dateOfBirth: null, confirmNew: false };
    if (op.fields.date_of_birth) hint.dateOfBirth = op.fields.date_of_birth;
    if (op.confirm_new_person) hint.confirmNew = true;
    hints.set(op.person.ref, hint);
  }
  return hints;
}

// Resolves a validated plan into ordered, confirmable steps using the caller's own read access.
export async function resolveRecordUpdatePlan({ rpc, organizationId, plan }) {
  const held = [...(plan?.held ?? [])];
  const steps = [];
  if (!isUuid(organizationId)) {
    return { steps, held: [...held, ...plan.operations.map((op) => ({ index: op.index, statement: op.kind, reason: 'Your account is not attached to an organisation, so nothing can be recorded.' }))] };
  }
  const plates = new Map();
  const people = new Map();
  const hints = personHints(plan.operations);
  for (const op of plan.operations) {
    const plate = op.plate ?? (op.target?.type === 'vehicle' ? op.target.plate : null);
    if (plate && !plates.has(plate)) plates.set(plate, await lookupPlate(rpc, plate));
    const person = op.person ?? (op.target?.type === 'person' ? op.target.person : null);
    if (person && !people.has(person.ref)) {
      people.set(person.ref, person.person_record_id
        ? await lookupPersonById(rpc, organizationId, person)
        : await lookupPerson(rpc, organizationId, person.name, hints.get(person.ref)));
    }
  }

  const registerPlanned = new Set();
  const personCreated = new Set();
  const canonicalKnown = new Map();
  const ensureVehicle = (op, plate, fields = {}) => {
    const state = plates.get(plate);
    if (state?.error) return { problem: `I could not look up ${plate} (${state.error}).` };
    if (state?.vehicle_id) return { vehicle_id: state.vehicle_id };
    if (!registerPlanned.has(plate)) {
      registerPlanned.add(plate);
      steps.push({
        kind: 'register_vehicle', op_index: op.index, plate, fields,
        label: `Register vehicle ${plate} in your organisation's vehicle register${Object.keys(fields).length ? ` with ${describeFields(fields)}` : ''} (${state?.seen ? 'seen in observations but not yet registered' : 'not yet on record'})`,
      });
      return { registered_with_fields: Object.keys(fields).length > 0 };
    }
    return {};
  };
  const personProblem = (state, person) => {
    if (state?.state === 'error') return state.reason;
    if (state?.state === 'ambiguous') return `${state.count} people match ${quote(person.name, 80)}; tell me which one (for example their date of birth or another detail).`;
    return null;
  };
  const similarPersonReason = (state, person) => `A similar person is already recorded (${state.close.map((name) => quote(name, 80)).join(', ')}). Tell me if ${quote(person.name, 80)} is one of them, or confirm they are a different person and I will create a new record.`;

  const ordered = [...plan.operations].sort((a, b) => (RESOLVE_ORDER[a.kind] - RESOLVE_ORDER[b.kind]) || (a.index - b.index));
  const personSteps = new Map();
  // People held for a near match: their links, names and warnings wait for the same answer.
  const awaitingIdentity = new Set();
  const awaitingReason = (person) => `Waiting for you to confirm who ${quote(person.name, 80)} is (see the similar-person item).`;
  for (const op of ordered) {
    const holdOp = (reason) => held.push({ index: op.index, statement: op.kind.replace(/_/g, ' '), reason });
    const subject = op.person ?? (op.target?.type === 'person' ? op.target.person : null);
    if (subject && op.kind !== 'person_details' && awaitingIdentity.has(subject.ref)) { holdOp(awaitingReason(subject)); continue; }
    if (op.kind === 'person_details') {
      const state = people.get(op.person.ref);
      const problem = personProblem(state, op.person);
      if (problem) { holdOp(problem); continue; }
      const earlier = personSteps.get(op.person.ref);
      if (earlier) {
        // The same person named twice in one request: one step carries every detail, and removing it drops both.
        Object.assign(earlier.fields, op.fields);
        earlier.op_indexes = [...stepSourceIndexes(earlier), op.index];
        earlier.label = personStepLabel(earlier);
        continue;
      }
      if (state.state === 'bound') {
        if (!Object.keys(op.fields).length) { holdOp(`${quote(state.display_name, 80)} is already recorded and no new details were given for them.`); continue; }
        const step = { kind: 'update_person_details', op_index: op.index, op_indexes: [op.index], person_ref: op.person.ref, person_record_id: state.person_record_id, display_name: state.display_name, fields: { ...op.fields } };
        step.label = personStepLabel(step);
        personSteps.set(op.person.ref, step);
        steps.push(step);
        continue;
      }
      if (state.close?.length) {
        awaitingIdentity.add(op.person.ref);
        holdOp(similarPersonReason(state, op.person));
        continue;
      }
      personCreated.add(op.person.ref);
      const step = compact({
        kind: 'create_person', op_index: op.index, op_indexes: [op.index], person_ref: op.person.ref, display_name: op.person.name, fields: { ...op.fields },
        distinct_from: state.distinct_from?.length ? state.distinct_from : null,
        confirmed_distinct: state.confirmed_distinct || null, different_birth_date: state.different_birth_date || null,
      });
      step.label = personStepLabel(step);
      personSteps.set(op.person.ref, step);
      steps.push(step);
    } else if (op.kind === 'vehicle_details') {
      const vehicle = ensureVehicle(op, op.plate, op.fields);
      if (vehicle.problem) { holdOp(vehicle.problem); continue; }
      if (vehicle.registered_with_fields) continue;
      steps.push({ kind: 'update_vehicle_details', op_index: op.index, plate: op.plate, vehicle_id: vehicle.vehicle_id ?? null, fields: op.fields, label: `Update vehicle ${op.plate}: ${describeFields(op.fields)} (shared vehicle profile, visible to every organisation that sees this plate)` });
    } else if (op.kind === 'vehicle_person_link') {
      const state = people.get(op.person.ref);
      const problem = personProblem(state, op.person);
      if (problem) { holdOp(problem); continue; }
      const plateState = plates.get(op.plate);
      if (plateState?.error) { holdOp(`I could not look up ${op.plate} (${plateState.error}).`); continue; }
      const fromCreate = personSteps.get(op.person.ref)?.kind === 'create_person';
      // A link that would make the person itself waits, like a create, while the register holds someone similar.
      if (state.state === 'new' && !fromCreate && state.close?.length) { holdOp(similarPersonReason(state, op.person)); continue; }
      const vehicle = ensureVehicle(op, op.plate);
      const creates = state.state === 'new' && !personCreated.has(op.person.ref);
      if (state.state === 'new') personCreated.add(op.person.ref);
      steps.push({
        kind: 'vehicle_person_link', op_index: op.index, plate: op.plate, vehicle_id: vehicle.vehicle_id ?? null,
        person_ref: op.person.ref, person_record_id: state.state === 'bound' ? state.person_record_id : null,
        display_name: state.state === 'bound' ? state.display_name : op.person.name, creates_person: creates,
        ...(fromCreate ? { person_from_create: true } : {}),
        relationship: op.relationship, source: op.source, basis: op.basis,
        label: `Link ${fromCreate ? `${op.person.name} (created above)` : creates ? personLabel(null, op.person) : personLabel(state, op.person)} to vehicle ${op.plate} as ${RELATIONSHIP_LABELS[op.relationship]} (${SOURCE_LABELS[op.source]})${op.relationship === 'owner' ? ' — this replaces any current owner link in your organisation' : ''}`,
      });
    } else if (op.kind === 'person_alias') {
      const state = people.get(op.person.ref);
      const problem = personProblem(state, op.person);
      if (problem) { holdOp(problem); continue; }
      if (state.state === 'new' && !personCreated.has(op.person.ref)) {
        holdOp(`No existing person matches ${quote(op.person.name, 80)}, so there is no one to add ${quote(op.alias, 60)} to yet. Ask me to create their person record as well and I will add this name to it.`);
        continue;
      }
      steps.push({
        kind: 'person_alias', op_index: op.index, person_ref: op.person.ref,
        person_record_id: state.state === 'bound' ? state.person_record_id : null,
        alias: op.alias, alias_kind: op.alias_kind, notes: op.notes,
        label: `Record ${quote(op.alias, 120)} as ${ALIAS_LABELS[op.alias_kind]} for ${state.state === 'bound' ? personLabel(state, op.person) : `${op.person.name} (created above)`}`,
      });
    } else if (op.kind === 'safety_warning') {
      const base = { kind: 'safety_warning', op_index: op.index, hazard_class: op.hazard_class, alert_level: op.alert_level, note: op.note };
      const warning = `${op.alert_level} safety warning (${HAZARD_LABELS[op.hazard_class]})`;
      const visibility = 'hazard class and severity are visible to every organisation; the note stays in yours';
      if (op.target.type === 'person') {
        const person = op.target.person;
        const state = people.get(person.ref);
        const problem = personProblem(state, person);
        if (problem) { holdOp(problem); continue; }
        let canonical = null;
        if (state.state === 'bound') {
          if (!canonicalKnown.has(person.ref)) canonicalKnown.set(person.ref, await lookupCanonicalPerson(rpc, organizationId, state.person_record_id, state.display_name));
          canonical = canonicalKnown.get(person.ref);
        }
        const linkedEarlier = steps.some((s) => (s.kind === 'vehicle_person_link' || s.kind === 'create_person') && s.person_ref === person.ref);
        if (!canonical && !linkedEarlier) {
          holdOp(state.state === 'new'
            ? `No existing person matches ${quote(person.name, 80)}, so there is no one to attach the safety warning to yet.`
            : `I could not confirm the platform identity for ${quote(state.display_name, 80)}; raise this warning from their person page.`);
          continue;
        }
        steps.push({ ...base, entity_type: 'person', entity_id: canonical, person_ref: person.ref, label: `Raise a ${warning} on ${state.state === 'bound' ? state.display_name : person.name}: ${quote(op.note, 1000)} (${visibility})` });
      } else if (op.target.type === 'vehicle') {
        const vehicle = ensureVehicle(op, op.target.plate);
        if (vehicle.problem) { holdOp(vehicle.problem); continue; }
        steps.push({ ...base, entity_type: 'vehicle', entity_id: vehicle.vehicle_id ?? null, plate: op.target.plate, label: `Raise a ${warning} on vehicle ${op.target.plate}: ${quote(op.note, 1000)} (${visibility})` });
      } else {
        steps.push({ ...base, entity_type: op.target.type, entity_id: op.target.id, label: `Raise a ${warning} on the ${op.target.type}${op.target.name ? ` ${op.target.name}` : ' you named'}: ${quote(op.note, 1000)} (${visibility})` });
      }
    } else if (op.kind === 'record_note') {
      steps.push({
        kind: 'record_note', op_index: op.index, record_kind: op.record_kind, record_id: op.record_id, entry_kind: op.entry_kind, body: op.body,
        label: `Add a ${ENTRY_LABELS[op.entry_kind]} to the ${RECORD_KIND_LABELS[op.record_kind]} you named: ${quote(op.body, 4000)}`,
      });
    }
  }
  // Each step is audited against the source of the items it was built from.
  const summaries = new Map(plan.operations.map((op) => [op.index, op.source_summary]));
  for (const step of steps) {
    const summary = joinSummaries(stepSourceIndexes(step).map((index) => summaries.get(index)));
    if (summary) step.source_summary = summary;
  }
  held.sort((a, b) => a.index - b.index);
  return { steps, held };
}

export function renderRecordUpdatePreview({ steps, held, amended = false }) {
  const lines = [];
  if (steps.length) {
    lines.push(`${amended ? 'Updated preview (your changes are included; it replaces the earlier one)' : 'Preview'} — I will make ${steps.length === 1 ? 'this change' : `these ${steps.length} changes`} as you, through the audited record tools:`);
    steps.forEach((step, i) => lines.push(`${i + 1}. ${step.label}`));
  } else {
    lines.push(amended
      ? 'With your changes there is nothing left that I can write safely, so the earlier preview is discarded and nothing will be written.'
      : 'I could not turn any of that into a change I can make safely.');
  }
  if (held.length) {
    lines.push('', 'Not included (nothing will be written for these):');
    for (const item of held) lines.push(`- ${item.statement}: ${item.reason}`);
  }
  if (steps.length) {
    lines.push('', 'Your role and organisation decide what the database accepts; anything it refuses will be reported, not hidden.');
    lines.push('Nothing has been written yet. Reply **yes** to apply these as you, or **no** to discard. To change something, tell me what to change and I will show a fresh preview.');
  }
  return lines.join('\n');
}

const CONFIRM = /^(?:yes|yep|yeah|yup|ok|okay|sure|confirm(?:ed)?|approve(?:d)?|go ahead|do it|proceed|apply(?: (?:it|them|these|those|the (?:changes|updates)))?)\b/;
// Only courtesy and restatement may follow the confirmation; any other word (an amendment or a question) is not a yes.
const CONFIRM_FILLER = new Set([
  'please', 'thanks', 'thank', 'you', 'cheers', 'bob', 'mate', 'and', 'go', 'ahead', 'do', 'it', 'apply', 'them', 'all',
  'that', "that's", 'thats', 'is', 'these', 'those', 'the', 'changes', 'updates', 'fine', 'good', 'great', 'perfect',
  'correct', 'right', 'sounds', 'looks', 'confirm', 'confirmed', 'approve', 'approved', 'proceed', 'yes', 'ok', 'okay', 'sure',
]);
const DECLINE = /^(?:no|nope|nah|cancel(?: (?:it|that|them))?|stop|discard(?: (?:it|that|them))?|leave it|not now|forget it|don'?t(?: (?:do|apply) (?:it|that|them))?|do not(?: (?:do|apply) (?:it|that|them))?)(?:[\s,]+(?:thanks|thank you|cheers|bob))*$/;

// A confirmation is short and unhedged; anything else goes back to the planner (for example an amendment).
export function recordUpdateDecision(message) {
  const t = String(message ?? '').replace(/[\u2018\u2019]/g, "'").trim().toLowerCase().replace(/[.!\s]+$/g, '').replace(/^bob[,\s]+/, '');
  if (!t || t.length > 80 || t.includes('?')) return null;
  if (DECLINE.test(t)) return 'decline';
  const rest = t.replace(CONFIRM, '');
  if (rest === t) return null;
  const words = rest.split(/[\s,;:.!-]+/).filter(Boolean);
  return words.every((word) => CONFIRM_FILLER.has(word)) ? 'confirm' : null;
}

/**
 * @param {any} stored
 * @param {{ userId?: string, conversationId?: string, organizationId?: string | null, now?: number }} [context]
 */
export function isTrustedPendingRecordUpdates(stored, { userId, conversationId, organizationId, now = Date.now() } = {}) {
  if (!isObject(stored)) return false;
  if (!isUuid(stored.plan_id) || stored.user_id !== userId || !userId) return false;
  if (!conversationId || stored.conversation_id !== conversationId) return false;
  if (!organizationId || stored.organization_id !== organizationId) return false;
  const created = Date.parse(String(stored.created_at ?? ''));
  if (!Number.isFinite(created) || now - created > RECORD_UPDATE_TTL_MS || created - now > 60_000) return false;
  if (!Array.isArray(stored.steps) || !stored.steps.length || stored.steps.length > RECORD_UPDATE_MAX_OPERATIONS * 2) return false;
  return stored.steps.every((s) => isObject(s) && STEP_KINDS.includes(s.kind) && typeof s.label === 'string');
}

// Any organisation member may insert bob_messages rows (RLS checks organisation access only), so a pending plan
// read back from the transcript is trusted only if it carries this server's signature over its exact contents.
const SIGNATURE_CONTEXT = 'fcm-bob-record-updates-v1';

// Key order and omitted (undefined) members are normalised so the plan verifies after its jsonb round trip.
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => (item === undefined ? 'null' : canonicalJson(item))).join(',')}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

async function planSignature(secret, pending) {
  const { signature: _ignored, ...unsigned } = pending;
  const encoder = new TextEncoder();
  const key = await globalThis.crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', key, encoder.encode(`${SIGNATURE_CONTEXT}\n${canonicalJson(unsigned)}`)));
  return [...mac].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function signPendingRecordUpdates(secret, pending) {
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('The record-update signing key is not configured.');
  return { ...pending, signature: await planSignature(secret, pending) };
}

export async function verifyPendingRecordUpdates(secret, pending) {
  if (typeof secret !== 'string' || secret.length < 32 || !isObject(pending)) return false;
  const given = pending.signature;
  if (typeof given !== 'string' || !/^[0-9a-f]{64}$/.test(given)) return false;
  const expected = await planSignature(secret, pending);
  let difference = 0;
  for (let i = 0; i < expected.length; i += 1) difference |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return difference === 0;
}

// Answers a stored preview exactly once. The conditional update re-checks the outcome under the row lock,
// so overlapping replies cannot both apply (or apply after a decline). 'amend' retires the preview before a
// successor is issued, so the earlier preview and its replacement can never both be confirmed.
// Uses the transcript client only.
const CLAIM_OUTCOMES = { confirm: 'confirmed', decline: 'declined', amend: 'amended' };
export async function claimRecordUpdatePreview({ db, messageId, conversationId, planId, answer, now = new Date() }) {
  if (!isUuid(messageId) || !conversationId || !isUuid(planId) || !Object.hasOwn(CLAIM_OUTCOMES, answer)) return false;
  const { data: row, error } = await db.from('bob_messages').select('metadata').eq('id', messageId).eq('conversation_id', conversationId).maybeSingle();
  const metadata = row?.metadata;
  if (error || !isObject(metadata) || metadata.outcome !== 'proposed' || metadata.pending_record_updates?.plan_id !== planId) return false;
  // A signed plan copied into a second row (a replay of an earlier preview) makes the plan id ambiguous: refuse it.
  const { data: carriers, error: carrierError } = await db.from('bob_messages').select('id')
    .eq('conversation_id', conversationId).eq('metadata->pending_record_updates->>plan_id', planId).limit(2);
  if (carrierError || !Array.isArray(carriers) || carriers.length !== 1 || carriers[0]?.id !== messageId) return false;
  const { data: claimed, error: claimError } = await db.from('bob_messages')
    .update({ metadata: { ...metadata, outcome: CLAIM_OUTCOMES[answer], record_updates_answered_at: now.toISOString() } })
    .eq('id', messageId).eq('conversation_id', conversationId).eq('metadata->>outcome', 'proposed')
    .select('id');
  return !claimError && Array.isArray(claimed) && claimed.length === 1;
}

const hexToUuid = (hex) => `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;

// Stable request id so a retried apply of the same plan step cannot raise a second warning.
export async function deterministicUuid(seed) {
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(seed))));
  const bytes = digest.slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return hexToUuid([...bytes].map((b) => b.toString(16).padStart(2, '0')).join(''));
}

function auditReason(sourceSummary) {
  return text(`Bob chat (confirmed by user): ${sourceSummary || 'information supplied in chat'}`, 300);
}

// Applies a confirmed plan in order with the caller's JWT-bound rpc. Each step reports what actually happened.
export async function applyRecordUpdatePlan({ rpc, organizationId, pending, deadlineAt = Date.now() + RECORD_UPDATE_APPLY_BUDGET_MS, now = () => Date.now() }) {
  // Each step is audited against its own source; previews made before per-item sources fall back to the plan's.
  const reasonFor = (step) => auditReason(text(step.source_summary, 240) || pending.source_summary);
  const vehicles = new Map();
  const people = new Map();
  const receipts = [];
  const receipt = (step, status, detail) => receipts.push({ kind: step.kind, label: step.label, status, ...(detail ? { detail: text(detail, 300) } : {}) });
  const vehicleFor = (step) => step.vehicle_id ?? vehicles.get(step.plate) ?? null;

  for (const [i, step] of pending.steps.entries()) {
    if (now() > deadlineAt) {
      receipt(step, 'not_attempted', 'Stopped before this step to stay within the request time limit. Ask me again and I will preview only what is still missing.');
      continue;
    }
    if (step.kind === 'create_person') {
      // One serialised database operation: it returns the person instead of inserting a second record when someone
      // with this exact name (and no conflicting date of birth) was recorded after the preview.
      const { data, error } = await call(rpc, PERSON_DETAILS_RPC, {
        p_organization_id: organizationId, p_person_record_id: null, p_action: 'create',
        p_fields: { ...(step.fields ?? {}), display_name: step.display_name },
        p_distinct_from: Array.isArray(step.distinct_from) ? step.distinct_from.filter(isUuid) : [], p_reason: reasonFor(step),
      });
      if (error) {
        const message = errorMessage(error);
        receipt(step, 'failed', /AMBIGUOUS_PERSON/.test(message)
          ? 'More than one person with this name is now recorded, so I did not create another. Tell me which one you mean.'
          : message);
        continue;
      }
      if (!isUuid(data?.person_record_id)) { receipt(step, 'failed', 'The register did not return the person record.'); continue; }
      people.set(step.person_ref, { person_record_id: data.person_record_id, canonical_person_id: isUuid(data?.canonical_person_id) ? data.canonical_person_id : null });
      if (data?.outcome === 'existing') {
        receipt(step, 'already_present', Object.keys(step.fields ?? {}).length
          ? 'This person was recorded after the preview, so no second record was made and their details were not changed; ask me again to add them.'
          : 'This person was recorded after the preview, so no second record was made.');
      } else receipt(step, 'applied');
      continue;
    }
    if (step.kind === 'update_person_details') {
      // Details only, under the row lock: the name is never sent, so a rename made since the preview stands.
      const { data, error } = await call(rpc, PERSON_DETAILS_RPC, {
        p_organization_id: organizationId, p_person_record_id: step.person_record_id, p_action: 'update',
        p_fields: step.fields ?? {}, p_distinct_from: [], p_reason: reasonFor(step),
      });
      if (error) {
        const message = errorMessage(error);
        receipt(step, 'failed', /merged into another record/i.test(message)
          ? 'This person has been merged into another record since the preview, so nothing was changed. Ask me again and I will preview the update for the record that was kept.'
          : message);
        continue;
      }
      people.set(step.person_ref, { person_record_id: step.person_record_id, canonical_person_id: isUuid(data?.canonical_person_id) ? data.canonical_person_id : null });
      if (data?.outcome === 'unchanged') receipt(step, 'already_present', 'These details are already on the person record.');
      else receipt(step, 'applied');
      continue;
    }
    if (step.kind === 'register_vehicle') {
      const current = await lookupPlate(rpc, step.plate);
      // Never register blind: manage_identity_vehicle clears this organisation's note on an existing vehicle.
      if (current.error) { receipt(step, 'failed', `Could not re-check ${step.plate} before registering (${current.error}).`); continue; }
      if (current.vehicle_id) {
        vehicles.set(step.plate, current.vehicle_id);
        if (!Object.keys(step.fields ?? {}).length) { receipt(step, 'already_present', 'The vehicle is already registered.'); continue; }
        const { data, error } = await call(rpc, 'update_vehicle_profile_details', { p_organization_id: organizationId, p_vehicle_id: current.vehicle_id, p_fields: step.fields, p_reason: reasonFor(step) });
        if (error) receipt(step, 'failed', errorMessage(error));
        else receipt(step, data?.changed === false ? 'already_present' : 'applied', 'The vehicle was already registered; its details were checked against what you gave.');
        continue;
      }
      const { data, error } = await call(rpc, 'manage_identity_vehicle', { p_organization_id: organizationId, p_vehicle_id: null, p_plate: step.plate, p_fields: step.fields ?? {}, p_reason: reasonFor(step) });
      if (error || !isUuid(data?.vehicle_id)) { receipt(step, 'failed', error ? errorMessage(error) : 'The register did not return the vehicle.'); continue; }
      vehicles.set(step.plate, data.vehicle_id);
      receipt(step, 'applied');
    } else if (step.kind === 'update_vehicle_details') {
      const vehicleId = vehicleFor(step);
      if (!vehicleId) { receipt(step, 'skipped_dependency', `Vehicle ${step.plate} was not registered.`); continue; }
      const { data, error } = await call(rpc, 'update_vehicle_profile_details', { p_organization_id: organizationId, p_vehicle_id: vehicleId, p_fields: step.fields, p_reason: reasonFor(step) });
      if (error) receipt(step, 'failed', errorMessage(error));
      else receipt(step, data?.changed === false ? 'already_present' : 'applied');
    } else if (step.kind === 'vehicle_person_link') {
      const vehicleId = vehicleFor(step);
      if (!vehicleId) { receipt(step, 'skipped_dependency', `Vehicle ${step.plate} was not registered.`); continue; }
      const known = people.get(step.person_ref);
      const personRecordId = step.person_record_id ?? known?.person_record_id ?? null;
      if (!personRecordId && step.person_from_create) { receipt(step, 'skipped_dependency', 'The person record was not created.'); continue; }
      const { data, error } = await call(rpc, 'record_vehicle_person', {
        p_organization_id: organizationId, p_canonical_vehicle_id: vehicleId, p_person_record_id: personRecordId,
        p_person_fields: personRecordId ? null : { display_name: step.display_name },
        p_relationship: step.relationship, p_source: step.source, p_basis: text(step.basis, 300) || reasonFor(step), p_observation_id: null,
      });
      if (error) {
        const message = errorMessage(error);
        receipt(step, 'failed', /^POSSIBLE_DUPLICATE/.test(message)
          ? 'A similar person may already be recorded. Tell me which existing person this is, or confirm they are a different person.'
          : message);
        continue;
      }
      if (isUuid(data?.person_record_id)) people.set(step.person_ref, { person_record_id: data.person_record_id, canonical_person_id: isUuid(data?.canonical_person_id) ? data.canonical_person_id : null });
      receipt(step, 'applied');
    } else if (step.kind === 'person_alias') {
      const personRecordId = step.person_record_id ?? people.get(step.person_ref)?.person_record_id ?? null;
      if (!personRecordId) { receipt(step, 'skipped_dependency', 'The person record was not created.'); continue; }
      const { error } = await call(rpc, 'add_person_alias', { p_person_record_id: personRecordId, p_alias: step.alias, p_alias_kind: step.alias_kind, p_notes: step.notes ?? null });
      if (!error) receipt(step, 'applied');
      else if (/already has that name recorded|already the main name/i.test(errorMessage(error))) receipt(step, 'already_present', 'That name is already recorded for this person.');
      else receipt(step, 'failed', errorMessage(error));
    } else if (step.kind === 'safety_warning') {
      let entityId = step.entity_id;
      if (!entityId && step.entity_type === 'person') entityId = people.get(step.person_ref)?.canonical_person_id ?? null;
      if (!entityId && step.entity_type === 'vehicle') entityId = vehicles.get(step.plate) ?? null;
      if (!entityId) {
        receipt(step, 'skipped_dependency', step.entity_type === 'vehicle' ? `Vehicle ${step.plate} was not registered.` : 'The person could not be confirmed on the platform.');
        continue;
      }
      const existing = await call(rpc, 'get_safety_warnings', { p_entity_type: step.entity_type, p_entity_ids: [entityId] });
      const ownSameHazard = (!existing.error && Array.isArray(existing.data) ? existing.data : [])
        .filter((w) => w?.is_own_organization === true && w?.hazard_class === step.hazard_class);
      if (ownSameHazard.some((w) => w?.alert_level === step.alert_level && String(w?.reason ?? '').trim() === String(step.note ?? '').trim())) {
        receipt(step, 'already_present', 'Your organisation already has this exact warning active on this record.');
        continue;
      }
      const { error } = await call(rpc, 'raise_entity_flag', {
        p_client_request_id: await deterministicUuid(`${pending.plan_id}:${i}`),
        p_entity_type: step.entity_type, p_entity_id: entityId, p_flag_type: 'safety_warning',
        p_alert_level: step.alert_level, p_reason: step.note, p_hazard_class: step.hazard_class,
      });
      if (error) receipt(step, 'failed', errorMessage(error));
      else {
        const levels = [...new Set(ownSameHazard.map((w) => w?.alert_level).filter(Boolean))].join('/');
        receipt(step, 'applied', ownSameHazard.length
          ? `Your organisation already had ${levels ? `a ${levels}` : 'a'} warning of this kind here; this one was added alongside it, and the earlier one stays active until someone resolves it.`
          : undefined);
      }
    } else if (step.kind === 'record_note') {
      const existing = await call(rpc, 'list_record_updates', { p_record_kind: step.record_kind, p_record_id: step.record_id });
      if (!existing.error && isRepeatRecordUpdate(Array.isArray(existing.data) ? existing.data : [], step)) {
        receipt(step, 'already_present', `That exact ${ENTRY_LABELS[step.entry_kind] ?? 'entry'} is already on the record.`);
        continue;
      }
      const { error } = await call(rpc, 'add_record_update', { p_record_kind: step.record_kind, p_record_id: step.record_id, p_entry_kind: step.entry_kind, p_body: step.body });
      if (error) receipt(step, 'failed', errorMessage(error));
      else receipt(step, 'applied');
    } else {
      receipt(step, 'failed', 'Unknown step; nothing was written for it.');
    }
  }
  const count = (status) => receipts.filter((r) => r.status === status).length;
  const applied = count('applied');
  const problems = count('failed') + count('skipped_dependency') + count('not_attempted');
  const outcome = applied ? (problems ? 'partially_applied' : 'applied') : (problems ? 'failed' : 'already_present');
  return { outcome, receipts };
}

const FOLLOW_UP_KINDS = new Set(['follow_up_requested', 'follow_up_resolved']);
const sameEntry = (row, step) => row?.entry_kind === step.entry_kind && String(row?.body ?? '').trim() === step.body.trim();

// Notes and safety concerns repeat only if the exact entry exists. A follow-up repeats only if it matches the
// latest follow-up entry (the one that sets the open/closed state), so re-opening a resolved follow-up still writes.
export function isRepeatRecordUpdate(rows, step) {
  if (!FOLLOW_UP_KINDS.has(step.entry_kind)) return rows.some((row) => sameEntry(row, step));
  const latest = rows
    .filter((row) => FOLLOW_UP_KINDS.has(row?.entry_kind))
    .sort((a, b) => (Date.parse(String(b?.created_at ?? '')) || 0) - (Date.parse(String(a?.created_at ?? '')) || 0))[0];
  return Boolean(latest) && sameEntry(latest, step);
}

const STATUS_WORDS = {
  applied: 'Done', already_present: 'Already on record', failed: 'Not done', skipped_dependency: 'Not attempted', not_attempted: 'Stopped (time limit)', held: 'Held',
};

export function renderRecordUpdateReceipts({ receipts, held = [] }) {
  const applied = receipts.filter((r) => r.status === 'applied').length;
  const lines = [applied
    ? `I made ${applied === 1 ? '1 change' : `${applied} changes`} as you. Here is exactly what happened:`
    : 'Nothing was written. Here is exactly what happened:'];
  receipts.forEach((r, i) => lines.push(`${i + 1}. ${STATUS_WORDS[r.status] ?? r.status} — ${r.label}${r.detail ? ` (${r.detail})` : ''}`));
  if (held.length) {
    lines.push('', 'Still not recorded (no governed path or more detail needed):');
    for (const item of held) lines.push(`- ${item.statement}: ${item.reason}`);
  }
  return lines.join('\n');
}
