import { recordFingerprint } from '../../services/document-source-worker/reconcile-plan.mjs';

const SCALE = 10n ** 18n;
const PATROL_RATE_CENTS = 3200n;

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

export function isCalendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function buildHistoricalPatrolLabourReport({ records, asOf }) {
  if (!Array.isArray(records) || !isCalendarDate(asOf)) {
    throw new Error('Source records and a valid as-of date are required');
  }
  const ordered = [...records].sort((a, b) =>
    `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`));
  const recordIds = new Set();
  const identities = new Map();
  const yearJobs = new Map();
  const days = new Map();
  const malformed = [];
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
    const officer = row.officer_id ?? null;
    const key = JSON.stringify([officer, row.work_date]);
    const day = days.get(key) ?? {
      key, officer_id: officer, work_date: row.work_date,
      recorded: 0n, reasons: new Set(), sources: [],
    };
    days.set(key, day);
    day.sources.push(row);
    if (!officer || row.officer_in_provider !== true) day.reasons.add('officer_identity_review_required');
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
    if (hours !== null) day.recorded += hours;

    const sourceCode = row.external_ref.split(':')[1] ?? '';
    const yearCode = /^(.*)(20\d{2})$/.exec(sourceCode);
    if (yearCode && row.job_number) {
      const jobKey = JSON.stringify([row.client_id, yearCode[1], row.job_number, row.work_date, officer]);
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
  const items = [...days.values()].sort((a, b) => a.key.localeCompare(b.key)).map(day => {
    if (day.recorded > 24n * SCALE) day.reasons.add('daily_hours_exceed_24');
    const reasons = [...day.reasons].sort();
    const candidate = reasons.length === 0 && day.recorded > 0n;
    const cents = (day.recorded * PATROL_RATE_CENTS + SCALE / 2n) / SCALE;
    return {
      officer_id: day.officer_id,
      work_date: day.work_date,
      status: reasons.length ? 'held' : candidate ? 'candidate' : 'evidence_only',
      reasons,
      recorded_hours: decimal(day.recorded),
      pay_code: candidate ? 'FORESTRY-PATROL' : null,
      hourly_rate: candidate ? '32.00' : null,
      estimated_pay: candidate ? `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}` : null,
      source_fingerprint: recordFingerprint(day.sources),
      sources: day.sources,
    };
  });
  const holdReasons = {};
  for (const item of items) for (const reason of item.reasons) holdReasons[reason] = (holdReasons[reason] ?? 0) + 1;
  return {
    format: 'fcm_historical_labour_readiness_v1',
    as_of: asOf,
    source_fingerprint: recordFingerprint(ordered),
    summary: {
      source_records: records.length,
      staff_days: items.length,
      candidate_days: items.filter(item => item.status === 'candidate').length,
      evidence_only_days: items.filter(item => item.status === 'evidence_only').length,
      held_days: items.filter(item => item.status === 'held').length,
      malformed_records: malformed.length,
      mirrored_records_not_counted_twice: mirrors,
      hold_reasons: holdReasons,
    },
    policy: {
      hours_basis: 'sum_source_job_time_hours_per_officer_day',
      patrol_hourly_rate: '32.00',
      engineer_hourly_rate_pending_classification: '55.00',
      unattributed_label: 'Relief Officer (No Name)',
      zero_hours_basis: 'zero_contributes_zero_all_zero_days_evidence_only',
      candidates_are_not_payroll_or_import_authorization: true,
    },
    items,
    malformed,
  };
}
