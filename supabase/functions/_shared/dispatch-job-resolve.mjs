// Pure helpers for Bob's dispatch_job tool: turn the words in a request
// ("send Don Squires Field to Burger N Beast for Gibbons, urgent") into the
// agreement, place, officer, job type, priority and response target that
// create_and_assign_dispatch_job needs. No I/O here; the conductor loads
// candidates with the caller's own access and the RPC re-checks everything.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const DISPATCH_JOB_TYPES = [
  { id: 'alarm_response', words: ['alarm', 'alarm response'] },
  { id: 'event', words: ['event'] },
  { id: 'incident', words: ['incident'] },
  { id: 'noise_control', words: ['noise', 'noise control', 'noise complaint'] },
  { id: 'patrol_support', words: ['patrol', 'patrol support', 'attend', 'attendance', 'callout', 'call out'] },
  { id: 'welfare_check', words: ['welfare', 'welfare check'] },
];

const DEFAULT_SLA = { urgent: 15, high: 30, normal: 60, low: 240 };

export function normalizeName(value) {
  return String(value ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim();
}

export function isUuid(value) {
  return UUID.test(String(value ?? '').trim());
}

// Single best match by id, exact name, then substring either way.
// Returns { status: 'one' | 'none' | 'many', match?, options? }.
export function matchByName(candidates, query, names = (row) => [row.name]) {
  const raw = String(query ?? '').trim();
  if (!raw) return { status: 'none' };
  if (isUuid(raw)) {
    const byId = candidates.find((row) => String(row.id).toLowerCase() === raw.toLowerCase());
    return byId ? { status: 'one', match: byId } : { status: 'none' };
  }
  const wanted = normalizeName(raw);
  if (!wanted) return { status: 'none' };
  const labelled = candidates.map((row) => ({ row, labels: names(row).map(normalizeName).filter(Boolean) }));
  const exact = labelled.filter(({ labels }) => labels.includes(wanted));
  if (exact.length === 1) return { status: 'one', match: exact[0].row };
  if (exact.length > 1) return { status: 'many', options: exact.map(({ row }) => row) };
  const partial = labelled.filter(({ labels }) => labels.some((label) => label.includes(wanted) || (wanted.length >= 4 && wanted.includes(label))));
  if (partial.length === 1) return { status: 'one', match: partial[0].row };
  if (partial.length > 1) return { status: 'many', options: partial.map(({ row }) => row) };
  return { status: 'none' };
}

export function normalizeJobType(value) {
  const wanted = normalizeName(value).replace(/ /g, '_');
  if (!wanted) return 'patrol_support';
  const byId = DISPATCH_JOB_TYPES.find((type) => type.id === wanted);
  if (byId) return byId.id;
  const spaced = wanted.replace(/_/g, ' ');
  const byWord = DISPATCH_JOB_TYPES.find((type) => type.words.includes(spaced));
  return byWord ? byWord.id : null;
}

export function normalizePriority(value) {
  const wanted = normalizeName(value);
  if (!wanted) return 'normal';
  if (['urgent', 'emergency', 'critical', 'asap', 'immediate'].includes(wanted)) return 'urgent';
  if (['high', 'priority', 'important'].includes(wanted)) return 'high';
  if (['normal', 'medium', 'standard', 'routine'].includes(wanted)) return 'normal';
  if (['low', 'whenever', 'non urgent'].includes(wanted)) return 'low';
  return null;
}

export function resolveSlaMinutes(value, priority) {
  if (value === undefined || value === null || value === '') return DEFAULT_SLA[priority] ?? 60;
  const minutes = Number(value);
  return Number.isInteger(minutes) && minutes >= 1 && minutes <= 1440 ? minutes : null;
}

// agreements: [{ id, name, client_name }]
// places: [{ id, kind: 'site' | 'zone', name, agreement_id }]
// Picks the agreement and place together so "Burger N Beast" alone is enough
// when it sits under exactly one agreement.
export function resolveDispatchPlace({ agreements, places, agreementQuery, placeQuery }) {
  let scopedAgreements = agreements;
  if (String(agreementQuery ?? '').trim()) {
    const picked = matchByName(agreements, agreementQuery, (row) => [row.name, row.client_name]);
    if (picked.status === 'none') return { status: 'agreement_not_found' };
    if (picked.status === 'many') return { status: 'agreement_ambiguous', options: picked.options };
    scopedAgreements = [picked.match];
  }
  const agreementIds = new Set(scopedAgreements.map((row) => row.id));
  const scopedPlaces = places.filter((place) => agreementIds.has(place.agreement_id));
  if (!String(placeQuery ?? '').trim()) {
    if (scopedAgreements.length === 1 && scopedPlaces.length === 1) {
      return { status: 'ok', agreement: scopedAgreements[0], place: scopedPlaces[0] };
    }
    return { status: 'place_required', options: scopedPlaces };
  }
  const picked = matchByName(scopedPlaces, placeQuery);
  if (picked.status === 'none') return { status: 'place_not_found', options: scopedPlaces };
  if (picked.status === 'many') {
    const sameAgreement = new Set(picked.options.map((place) => place.agreement_id));
    return { status: 'place_ambiguous', options: picked.options, crossAgreement: sameAgreement.size > 1 };
  }
  const agreement = scopedAgreements.find((row) => row.id === picked.match.agreement_id);
  return { status: 'ok', agreement, place: picked.match };
}

export function describeOptions(rows, label = (row) => row.name, max = 8) {
  const shown = rows.slice(0, max).map((row) => `- ${label(row)}`);
  if (rows.length > max) shown.push(`- …and ${rows.length - max} more`);
  return shown.join('\n');
}
