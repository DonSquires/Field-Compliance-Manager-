import { recordFingerprint } from '../../services/document-source-worker/reconcile-plan.mjs';

const SCALE = 10n ** 18n;
const PATROL_RATE_CENTS = 3200n;
const HOUR_MS = 3_600_000n;

export const RELIEF_OFFICER_ID = 'f1c00000-0000-4000-8000-000000000002';
export const RELIEF_OFFICER_NAME = 'Relief Officer (No Name)';
export const LABOUR_SOURCE = 'rm_patrol_log_labour';
// Owner rulings: these days are recorded as evidence only, never paid or held.
const EVIDENCE_ONLY_REASONS = new Set(['missing_or_invalid_hours', 'daily_hours_exceed_24', 'non_labour_source_label']);
const NON_LABOUR_LABELS = new Set(['camera', 'external', 'digger']);
const CREW_SEPARATOR = /\s(?:and|&)\s|[&+,/]/i;

function hoursValue(value) {
  const text = String(value ?? '').trim();
  if (!/^\d+(?:\.\d{1,18})?$/.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(18, '0'));
}

function decimal(value) {
  const fraction = String(value % SCALE).padStart(18, '0').replace(/0+$/, '');
  return `${value / SCALE}${fraction ? `.${fraction}` : ''}`;
}

const aucklandDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland', year: 'numeric', month: '2-digit', day: '2-digit' });

export function isCalendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function distance(a, b) {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const above = previous[j];
      previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return previous[b.length];
}

export function nameTokens(value) {
  return String(value ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/\.{2,}|\u2026/g, ' ').replace(/[^a-z\s'-]/g, ' ').replace(/['-]/g, ' ')
    .split(/\s+/).filter(Boolean);
}

/** "Rob Crawford field" is the field (staff) account of "Rob Crawford"; the suffix is not part of the name. */
function staffNameTokens(value) {
  const tokens = nameTokens(value);
  return tokens.length > 2 && tokens.at(-1) === 'field' ? tokens.slice(0, -1) : tokens;
}

const firstCompatible = (a, b) => a === b
  || (Math.min(a.length, b.length) >= 3 && (a.startsWith(b) || b.startsWith(a)))
  || (Math.min(a.length, b.length) >= 4 && distance(a, b) <= 1);
const surnameCompatible = (a, b) => a === b || (Math.min(a.length, b.length) >= 5 && distance(a, b) <= 1);

/**
 * Owner ruling: names need not match exactly. Surname is the strongest signal; first names may be
 * shortened (Deb/Deborah) or vary by one letter (Sheryl/Cheryl). Anything not unique is held.
 */
export function resolveStaffIdentity(rawName, staff) {
  const raw = String(rawName ?? '').trim();
  const tokens = nameTokens(raw);
  if (!tokens.length) return { kind: 'unattributed' };
  if (tokens.length === 1 && NON_LABOUR_LABELS.has(tokens[0])) return { kind: 'non_labour', label: tokens[0] };
  if (CREW_SEPARATOR.test(raw.replace(/\.{2,}|\u2026/g, ''))) return { kind: 'review', reason: 'crew_attribution_review_required' };
  const people = staff.map(person => ({ ...person, tokens: staffNameTokens(person.display_name) })).filter(person => person.tokens.length);
  if (tokens.length === 1) {
    const matches = people.filter(person => firstCompatible(tokens[0], person.tokens[0]));
    if (matches.length === 1) return { kind: 'matched', officer_id: matches[0].id, method: 'unique_first_name' };
    return matches.length ? { kind: 'review', reason: 'officer_identity_ambiguous' } : { kind: 'unattributed' };
  }
  const surname = tokens.slice(1).join(' ');
  let matches = people.filter(person => person.tokens.length > 1
    && surnameCompatible(surname, person.tokens.slice(1).join(' ')) && firstCompatible(tokens[0], person.tokens[0]));
  if (matches.length > 1) {
    const exact = matches.filter(person => person.tokens.join(' ') === tokens.join(' '));
    if (exact.length !== 1) return { kind: 'review', reason: 'officer_identity_ambiguous' };
    matches = exact;
  }
  if (matches.length === 1) {
    return {
      kind: 'matched',
      officer_id: matches[0].id,
      method: matches[0].tokens.join(' ') === tokens.join(' ') ? 'exact_name' : 'surname_and_compatible_first_name',
    };
  }
  return { kind: 'review', reason: matches.length ? 'officer_identity_ambiguous' : 'officer_identity_unknown_person' };
}

function durationMs(hours) {
  return Number((hours * HOUR_MS + SCALE / 2n) / SCALE);
}

/** Summed hours carry no source clock times: anchor at the first entry and chain without overlaps. */
function planSlots(items) {
  const lastEnd = new Map();
  for (const item of items) {
    if (item.status !== 'candidate') continue;
    const anchors = item.counted.map(row => Date.parse(row.happened_at));
    if (!anchors.length || anchors.some(value => !Number.isFinite(value))) {
      item.reasons.push('source_time_missing');
      continue;
    }
    let cursor = Math.max(Math.min(...anchors), lastEnd.get(item.officer_id) ?? -Infinity);
    if (aucklandDate.format(new Date(cursor)) !== item.work_date) {
      item.reasons.push('roster_time_overlap_review_required');
      continue;
    }
    const byClient = new Map();
    for (const row of item.counted) {
      const segment = byClient.get(row.client_id) ?? { client_id: row.client_id, hours: 0n, first: Infinity, records: [] };
      segment.hours += hoursValue(row.hours);
      segment.first = Math.min(segment.first, Date.parse(row.happened_at));
      segment.records.push(`${row.kind}:${row.id}`);
      byClient.set(row.client_id, segment);
    }
    item.slots = [...byClient.values()].filter(segment => segment.hours > 0n)
      .sort((a, b) => a.first - b.first || a.client_id.localeCompare(b.client_id))
      .map(segment => {
        const start = cursor;
        cursor += durationMs(segment.hours);
        return {
          source_key: `${LABOUR_SOURCE}:${item.officer_id}:${item.work_date}:${segment.client_id}`,
          staff_id: item.officer_id,
          client_organization_id: segment.client_id,
          work_date: item.work_date,
          scheduled_start: new Date(start).toISOString(),
          scheduled_end: new Date(cursor).toISOString(),
          recorded_hours: decimal(segment.hours),
          source_records: segment.records.sort(),
        };
      });
    lastEnd.set(item.officer_id, cursor);
  }
  for (const item of items) {
    if (item.status === 'candidate' && item.reasons.length) {
      item.status = 'held';
      item.reasons.sort();
      item.slots = [];
    }
  }
}

/**
 * Owner ruling (2026-10-25): labour linked to a login that has no staff record (e.g. a master
 * account) belongs to the same person's field/staff account.
 */
function staffAccountFor(officerId, staff, accounts) {
  const account = accounts.find(entry => entry.id === officerId);
  if (!account) return null;
  const resolution = resolveStaffIdentity(account.display_name, staff);
  return resolution.kind === 'matched' ? resolution.officer_id : null;
}

export function buildHistoricalPatrolLabourReport({ records, asOf, staff = [], accounts = [] }) {
  if (!Array.isArray(records) || !isCalendarDate(asOf) || !Array.isArray(staff) || !Array.isArray(accounts)) {
    throw new Error('Source records, staff and a valid as-of date are required');
  }
  const staffIds = new Set(staff.map(person => person.id));
  const ordered = [...records].sort((a, b) =>
    `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`));
  const recordIds = new Set();
  const identities = new Map();
  const yearJobs = new Map();
  const days = new Map();
  const malformed = [];
  const resolutions = {};
  let mirrors = 0;

  for (const row of ordered) {
    if (!['event', 'observation'].includes(row.kind) || !row.id || !row.client_id) {
      throw new Error('Every source record requires its kind, ID and client organization');
    }
    const recordId = `${row.kind}:${row.id}`;
    if (recordIds.has(recordId)) throw new Error('Repeated source record ID');
    recordIds.add(recordId);
    if (!isCalendarDate(row.work_date)) {
      malformed.push({ record: recordId, reason: 'invalid_work_date' });
      continue;
    }
    let officer = row.officer_id && row.officer_in_provider === true ? row.officer_id : null;
    let identityReason = null;
    let evidenceLabel = null;
    if (officer && staffIds.size && !staffIds.has(officer)) {
      const mapped = staffAccountFor(officer, staff, accounts);
      const tally = mapped ? 'login_to_staff_account' : 'officer_without_staff_record';
      resolutions[tally] = (resolutions[tally] ?? 0) + 1;
      if (mapped) officer = mapped;
      else {
        identityReason = 'officer_identity_review_required';
        officer = null;
      }
    }
    if (!officer && !identityReason) {
      const resolution = row.officer_id ? { kind: 'review', reason: 'officer_identity_review_required' }
        : resolveStaffIdentity(row.patroller_raw, staff);
      const tally = resolution.method ?? resolution.reason ?? resolution.kind;
      resolutions[tally] = (resolutions[tally] ?? 0) + 1;
      if (resolution.kind === 'matched') officer = resolution.officer_id;
      else if (resolution.kind === 'unattributed') officer = RELIEF_OFFICER_ID;
      else if (resolution.kind === 'non_labour') evidenceLabel = resolution.label;
      else identityReason = resolution.reason;
    }
    const officerKey = officer
      ?? (evidenceLabel ? `label:${evidenceLabel}` : `unresolved:${row.officer_id ?? nameTokens(row.patroller_raw).join(' ')}`);
    const key = JSON.stringify([officerKey, row.work_date]);
    const day = days.get(key) ?? {
      key, officer_id: officer, label: evidenceLabel, work_date: row.work_date,
      recorded: 0n, reasons: new Set(), sources: [], counted: [],
    };
    days.set(key, day);
    day.sources.push(row);
    if (identityReason) day.reasons.add(identityReason);
    if (evidenceLabel) day.reasons.add('non_labour_source_label');
    if (row.work_date > asOf) day.reasons.add('future_work_date');
    if (row.crew_review_required) day.reasons.add('crew_attribution_review_required');
    if (row.engineering_review_required) day.reasons.add('engineering_pay_review_required');
    if (row.equipment_review_required) day.reasons.add('equipment_not_additional_labour_review_required');
    if (row.source_review_required) day.reasons.add('source_reconciliation_review_required');
    const hours = hoursValue(row.hours);
    if (hours === null) day.reasons.add('missing_or_invalid_hours');
    if (!row.external_ref) {
      day.reasons.add('source_identity_missing');
      continue;
    }
    const identity = JSON.stringify([row.client_id, row.external_ref]);
    const prior = identities.get(identity);
    if (prior) {
      const sameEvidence = prior.row.officer_id === row.officer_id
        && (prior.row.patroller_raw ?? null) === (row.patroller_raw ?? null)
        && prior.row.work_date === row.work_date && hoursValue(prior.row.hours) === hours
        && prior.row.job_number === row.job_number
        && hours !== null && !prior.kinds.has(row.kind);
      if (sameEvidence) {
        mirrors += 1;
        prior.kinds.add(row.kind);
      }
      else {
        day.reasons.add('duplicate_source_conflict');
        prior.day.reasons.add('duplicate_source_conflict');
      }
      continue;
    }
    identities.set(identity, { row, day, kinds: new Set([row.kind]) });
    if (hours !== null) {
      day.recorded += hours;
      day.counted.push(row);
    }

    const sourceCode = row.external_ref.split(':')[1] ?? '';
    const yearCode = /^(.*)(20\d{2})$/.exec(sourceCode);
    if (yearCode && row.job_number) {
      const jobKey = JSON.stringify([row.client_id, yearCode[1], row.job_number, row.work_date, officerKey]);
      const peers = yearJobs.get(jobKey) ?? [];
      for (const peer of peers) {
        if (peer.sourceCode !== sourceCode) {
          peer.day.reasons.add('year_sheet_overlap_review_required');
          day.reasons.add('year_sheet_overlap_review_required');
        }
      }
      peers.push({ sourceCode, day });
      yearJobs.set(jobKey, peers);
    }
  }
  const working = [...days.values()].sort((a, b) => a.key.localeCompare(b.key)).map(day => {
    if (day.recorded > 24n * SCALE) day.reasons.add('daily_hours_exceed_24');
    const all = [...day.reasons].sort();
    const reasons = all.filter(reason => !EVIDENCE_ONLY_REASONS.has(reason));
    const evidenceReasons = all.filter(reason => EVIDENCE_ONLY_REASONS.has(reason));
    const status = reasons.length ? 'held' : evidenceReasons.length || day.recorded === 0n ? 'evidence_only' : 'candidate';
    return { ...day, status, reasons, evidence_reasons: evidenceReasons, slots: [] };
  });
  planSlots([...working].sort((a, b) =>
    `${a.officer_id}|${a.work_date}`.localeCompare(`${b.officer_id}|${b.work_date}`)));
  const items = working.map(day => {
    const candidate = day.status === 'candidate';
    const cents = (day.recorded * PATROL_RATE_CENTS + SCALE / 2n) / SCALE;
    const fingerprint = recordFingerprint(day.sources);
    return {
      officer_id: day.officer_id,
      placeholder_identity: day.officer_id === RELIEF_OFFICER_ID,
      evidence_label: day.label,
      work_date: day.work_date,
      status: day.status,
      reasons: day.reasons,
      evidence_reasons: day.evidence_reasons,
      recorded_hours: decimal(day.recorded),
      pay_code: candidate ? 'FORESTRY-PATROL' : null,
      hourly_rate: candidate ? '32.00' : null,
      estimated_pay: candidate ? `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}` : null,
      source_fingerprint: fingerprint,
      slots: day.slots.map(slot => ({ ...slot, source_fingerprint: fingerprint })),
      sources: day.sources,
    };
  });
  const holdReasons = {};
  const evidenceReasons = {};
  for (const item of items) {
    for (const reason of item.reasons) holdReasons[reason] = (holdReasons[reason] ?? 0) + 1;
    for (const reason of item.evidence_reasons) evidenceReasons[reason] = (evidenceReasons[reason] ?? 0) + 1;
  }
  const slots = items.flatMap(item => item.slots);
  return {
    format: 'fcm_historical_labour_readiness_v2',
    as_of: asOf,
    source_fingerprint: recordFingerprint(ordered),
    summary: {
      source_records: records.length,
      staff_days: items.length,
      candidate_days: items.filter(item => item.status === 'candidate').length,
      relief_candidate_days: items.filter(item => item.status === 'candidate' && item.placeholder_identity).length,
      evidence_only_days: items.filter(item => item.status === 'evidence_only').length,
      held_days: items.filter(item => item.status === 'held').length,
      roster_slots_planned: slots.length,
      malformed_records: malformed.length,
      mirrored_records_not_counted_twice: mirrors,
      unlinked_name_resolutions: resolutions,
      hold_reasons: holdReasons,
      evidence_only_reasons: evidenceReasons,
    },
    policy: {
      hours_basis: 'sum_source_job_time_hours_per_officer_day',
      patrol_hourly_rate: '32.00',
      engineer_hourly_rate_pending_classification: '55.00',
      unattributed_label: RELIEF_OFFICER_NAME,
      zero_hours_basis: 'zero_contributes_zero_all_zero_days_evidence_only',
      blank_or_invalid_hours: 'whole_day_evidence_only',
      over_24_hours: 'evidence_only',
      identity_matching: 'surname_with_compatible_or_shortened_first_name',
      slot_timing: 'anchored_at_first_entry_chained_summed_hours',
      candidates_are_not_payroll_or_import_authorization: true,
    },
    items,
    slots,
    malformed,
  };
}
