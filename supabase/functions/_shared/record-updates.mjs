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
const STEP_KINDS = ['register_vehicle', 'update_vehicle_details', 'vehicle_person_link', 'person_alias', 'safety_warning', 'record_note'];
// Person-creating links resolve before facts about that person, whatever order they were given in.
const RESOLVE_ORDER = { vehicle_details: 0, vehicle_person_link: 1, person_alias: 2, safety_warning: 3, record_note: 4 };
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

function personKey(name) {
  return String(name ?? '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9' -]/g, ' ').replace(/\s+/g, ' ').trim();
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

function describeFields(fields) {
  return Object.entries(fields).map(([key, value]) => `${key.replace(/_/g, ' ')} ${value}`).join(', ');
}

function normaliseOperation(raw, index, sourceSummary) {
  const hold = (reason) => ({ held: { index, statement: text(raw?.statement ?? raw?.kind ?? 'update', 200), reason } });
  if (!isObject(raw)) return hold('This item was not a structured update.');
  const kind = text(raw.kind, 40);
  switch (kind) {
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

async function lookupPerson(rpc, organizationId, name) {
  const { data, error } = await call(rpc, 'find_person_matches', { p_organization_id: organizationId, p_name: name, p_limit: 8 });
  if (error) return { state: 'error', reason: personLookupProblem(errorMessage(error)) };
  const rows = Array.isArray(data) ? data : [];
  const exact = rows.filter((r) => isUuid(r?.person_record_id) && EXACT_MATCH_BASES.has(String(r.match_basis)) && Number(r.score) >= 0.85);
  const ids = [...new Set(exact.map((r) => r.person_record_id))];
  if (ids.length === 1) {
    const row = exact.find((r) => r.person_record_id === ids[0]);
    return { state: 'bound', person_record_id: ids[0], display_name: text(row.display_name, 120) || name };
  }
  if (ids.length > 1) return { state: 'ambiguous', count: ids.length };
  return { state: 'new', similar: rows.length };
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

// Resolves a validated plan into ordered, confirmable steps using the caller's own read access.
export async function resolveRecordUpdatePlan({ rpc, organizationId, plan }) {
  const held = [...(plan?.held ?? [])];
  const steps = [];
  if (!isUuid(organizationId)) {
    return { steps, held: [...held, ...plan.operations.map((op) => ({ index: op.index, statement: op.kind, reason: 'Your account is not attached to an organisation, so nothing can be recorded.' }))] };
  }
  const plates = new Map();
  const people = new Map();
  for (const op of plan.operations) {
    const plate = op.plate ?? (op.target?.type === 'vehicle' ? op.target.plate : null);
    if (plate && !plates.has(plate)) plates.set(plate, await lookupPlate(rpc, plate));
    const person = op.person ?? (op.target?.type === 'person' ? op.target.person : null);
    if (person && !people.has(person.ref)) {
      people.set(person.ref, person.person_record_id
        ? { state: 'bound', person_record_id: person.person_record_id, display_name: person.name ?? 'the named person record' }
        : await lookupPerson(rpc, organizationId, person.name));
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

  const ordered = [...plan.operations].sort((a, b) => (RESOLVE_ORDER[a.kind] - RESOLVE_ORDER[b.kind]) || (a.index - b.index));
  for (const op of ordered) {
    const holdOp = (reason) => held.push({ index: op.index, statement: op.kind.replace(/_/g, ' '), reason });
    if (op.kind === 'vehicle_details') {
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
      const vehicle = ensureVehicle(op, op.plate);
      const creates = state.state === 'new' && !personCreated.has(op.person.ref);
      if (state.state === 'new') personCreated.add(op.person.ref);
      steps.push({
        kind: 'vehicle_person_link', op_index: op.index, plate: op.plate, vehicle_id: vehicle.vehicle_id ?? null,
        person_ref: op.person.ref, person_record_id: state.state === 'bound' ? state.person_record_id : null,
        display_name: state.state === 'bound' ? state.display_name : op.person.name, creates_person: creates,
        relationship: op.relationship, source: op.source, basis: op.basis,
        label: `Link ${creates ? personLabel(null, op.person) : personLabel(state, op.person)} to vehicle ${op.plate} as ${RELATIONSHIP_LABELS[op.relationship]} (${SOURCE_LABELS[op.source]})${op.relationship === 'owner' ? ' — this replaces any current owner link in your organisation' : ''}`,
      });
    } else if (op.kind === 'person_alias') {
      const state = people.get(op.person.ref);
      const problem = personProblem(state, op.person);
      if (problem) { holdOp(problem); continue; }
      if (state.state === 'new' && !personCreated.has(op.person.ref)) {
        holdOp(`No existing person matches ${quote(op.person.name, 80)}, so there is no one to add ${quote(op.alias, 60)} to yet.`);
        continue;
      }
      steps.push({
        kind: 'person_alias', op_index: op.index, person_ref: op.person.ref,
        person_record_id: state.state === 'bound' ? state.person_record_id : null,
        alias: op.alias, alias_kind: op.alias_kind, notes: op.notes,
        label: `Record ${quote(op.alias, 80)} as ${ALIAS_LABELS[op.alias_kind]} for ${state.state === 'bound' ? personLabel(state, op.person) : `${op.person.name} (created above)`}`,
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
        const linkedEarlier = steps.some((s) => s.kind === 'vehicle_person_link' && s.person_ref === person.ref);
        if (!canonical && !linkedEarlier) {
          holdOp(state.state === 'new'
            ? `No existing person matches ${quote(person.name, 80)}, so there is no one to attach the safety warning to yet.`
            : `I could not confirm the platform identity for ${quote(state.display_name, 80)}; raise this warning from their person page.`);
          continue;
        }
        steps.push({ ...base, entity_type: 'person', entity_id: canonical, person_ref: person.ref, label: `Raise a ${warning} on ${state.state === 'bound' ? state.display_name : person.name}: ${quote(op.note)} (${visibility})` });
      } else if (op.target.type === 'vehicle') {
        const vehicle = ensureVehicle(op, op.target.plate);
        if (vehicle.problem) { holdOp(vehicle.problem); continue; }
        steps.push({ ...base, entity_type: 'vehicle', entity_id: vehicle.vehicle_id ?? null, plate: op.target.plate, label: `Raise a ${warning} on vehicle ${op.target.plate}: ${quote(op.note)} (${visibility})` });
      } else {
        steps.push({ ...base, entity_type: op.target.type, entity_id: op.target.id, label: `Raise a ${warning} on the ${op.target.type}${op.target.name ? ` ${op.target.name}` : ' you named'}: ${quote(op.note)} (${visibility})` });
      }
    } else if (op.kind === 'record_note') {
      steps.push({
        kind: 'record_note', op_index: op.index, record_kind: op.record_kind, record_id: op.record_id, entry_kind: op.entry_kind, body: op.body,
        label: `Add a ${ENTRY_LABELS[op.entry_kind]} to the ${RECORD_KIND_LABELS[op.record_kind]} you named: ${quote(op.body, 200)}`,
      });
    }
  }
  held.sort((a, b) => a.index - b.index);
  return { steps, held };
}

export function renderRecordUpdatePreview({ steps, held }) {
  const lines = [];
  if (steps.length) {
    lines.push(`Preview — I will make ${steps.length === 1 ? 'this change' : `these ${steps.length} changes`} as you, through the audited record tools:`);
    steps.forEach((step, i) => lines.push(`${i + 1}. ${step.label}`));
  } else {
    lines.push('I could not turn any of that into a change I can make safely.');
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

// Answers a stored preview exactly once. The conditional update re-checks the outcome under the row lock,
// so overlapping replies cannot both apply (or apply after a decline). Uses the transcript client only.
export async function claimRecordUpdatePreview({ db, messageId, conversationId, planId, answer, now = new Date() }) {
  if (!isUuid(messageId) || !conversationId || !isUuid(planId) || !['confirm', 'decline'].includes(answer)) return false;
  const { data: row, error } = await db.from('bob_messages').select('metadata').eq('id', messageId).eq('conversation_id', conversationId).maybeSingle();
  const metadata = row?.metadata;
  if (error || !isObject(metadata) || metadata.outcome !== 'proposed' || metadata.pending_record_updates?.plan_id !== planId) return false;
  const { data: claimed, error: claimError } = await db.from('bob_messages')
    .update({ metadata: { ...metadata, outcome: answer === 'confirm' ? 'confirmed' : 'declined', record_updates_answered_at: now.toISOString() } })
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
  const reason = auditReason(pending.source_summary);
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
    if (step.kind === 'register_vehicle') {
      const current = await lookupPlate(rpc, step.plate);
      // Never register blind: manage_identity_vehicle clears this organisation's note on an existing vehicle.
      if (current.error) { receipt(step, 'failed', `Could not re-check ${step.plate} before registering (${current.error}).`); continue; }
      if (current.vehicle_id) {
        vehicles.set(step.plate, current.vehicle_id);
        if (!Object.keys(step.fields ?? {}).length) { receipt(step, 'already_present', 'The vehicle is already registered.'); continue; }
        const { data, error } = await call(rpc, 'update_vehicle_profile_details', { p_organization_id: organizationId, p_vehicle_id: current.vehicle_id, p_fields: step.fields, p_reason: reason });
        if (error) receipt(step, 'failed', errorMessage(error));
        else receipt(step, data?.changed === false ? 'already_present' : 'applied', 'The vehicle was already registered; its details were checked against what you gave.');
        continue;
      }
      const { data, error } = await call(rpc, 'manage_identity_vehicle', { p_organization_id: organizationId, p_vehicle_id: null, p_plate: step.plate, p_fields: step.fields ?? {}, p_reason: reason });
      if (error || !isUuid(data?.vehicle_id)) { receipt(step, 'failed', error ? errorMessage(error) : 'The register did not return the vehicle.'); continue; }
      vehicles.set(step.plate, data.vehicle_id);
      receipt(step, 'applied');
    } else if (step.kind === 'update_vehicle_details') {
      const vehicleId = vehicleFor(step);
      if (!vehicleId) { receipt(step, 'skipped_dependency', `Vehicle ${step.plate} was not registered.`); continue; }
      const { data, error } = await call(rpc, 'update_vehicle_profile_details', { p_organization_id: organizationId, p_vehicle_id: vehicleId, p_fields: step.fields, p_reason: reason });
      if (error) receipt(step, 'failed', errorMessage(error));
      else receipt(step, data?.changed === false ? 'already_present' : 'applied');
    } else if (step.kind === 'vehicle_person_link') {
      const vehicleId = vehicleFor(step);
      if (!vehicleId) { receipt(step, 'skipped_dependency', `Vehicle ${step.plate} was not registered.`); continue; }
      const known = people.get(step.person_ref);
      const personRecordId = step.person_record_id ?? known?.person_record_id ?? null;
      const { data, error } = await call(rpc, 'record_vehicle_person', {
        p_organization_id: organizationId, p_canonical_vehicle_id: vehicleId, p_person_record_id: personRecordId,
        p_person_fields: personRecordId ? null : { display_name: step.display_name },
        p_relationship: step.relationship, p_source: step.source, p_basis: text(step.basis, 300) || reason, p_observation_id: null,
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
      if (!existing.error && (Array.isArray(existing.data) ? existing.data : []).some((row) => row?.entry_kind === step.entry_kind && String(row?.body ?? '').trim() === step.body.trim())) {
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
