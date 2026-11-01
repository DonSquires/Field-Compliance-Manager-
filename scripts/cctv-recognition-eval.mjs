#!/usr/bin/env node

const ENTITY_KINDS = ['animal', 'person', 'vehicle'];
const REVIEW_STATES = new Set(['accepted', 'rejected', 'uncertain', 'needs_more_context', 'unreviewed', 'superseded']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function wilsonLowerBound(successes, total) {
  if (!total) return null;
  const z = 1.96;
  const p = successes / total;
  const denominator = 1 + (z * z) / total;
  const centre = p + (z * z) / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * total)) / total);
  return Number(((centre - margin) / denominator).toFixed(4));
}

function emptyCounts() {
  return { accepted: 0, rejected: 0, inconclusive: 0, pending: 0, decided: 0, precision: null, precision_lower_bound: null };
}

function precisionForRows(rows) {
  const groups = new Map(ENTITY_KINDS.map((kind) => [kind, emptyCounts()]));
  for (const row of rows) {
    if (!row || !groups.has(row.entity_kind) || !REVIEW_STATES.has(row.review_state)) {
      throw new TypeError('Each evaluation row must have a supported entity_kind and review_state');
    }
    const counts = groups.get(row.entity_kind);
    if (row.review_state === 'accepted') counts.accepted += 1;
    else if (row.review_state === 'rejected') counts.rejected += 1;
    else if (row.review_state === 'uncertain' || row.review_state === 'needs_more_context') counts.inconclusive += 1;
    else if (row.review_state === 'unreviewed') counts.pending += 1;
  }
  for (const counts of groups.values()) {
    counts.decided = counts.accepted + counts.rejected;
    if (counts.decided) {
      counts.precision = Number((counts.accepted / counts.decided).toFixed(4));
      counts.precision_lower_bound = wilsonLowerBound(counts.accepted, counts.decided);
    }
  }
  return Object.fromEntries([...groups.entries()].map(([kind, counts]) => [kind, counts]));
}

function normalizedPlate(value) {
  return typeof value === 'string' ? value.toUpperCase().replace(/[^A-Z0-9]/g, '') : '';
}

function fixtureIdentityMetrics(rows) {
  const truthToClusters = new Map();
  const clusterToTruths = new Map();
  for (const row of rows) {
    if (row.entity_kind !== 'person' || row.review_state !== 'accepted') continue;
    if (typeof row.ground_truth_entity_id !== 'string' || typeof row.predicted_cluster_id !== 'string') continue;
    if (!row.ground_truth_entity_id || !row.predicted_cluster_id) continue;
    const clusters = truthToClusters.get(row.ground_truth_entity_id) || new Set();
    clusters.add(row.predicted_cluster_id);
    truthToClusters.set(row.ground_truth_entity_id, clusters);
    const truths = clusterToTruths.get(row.predicted_cluster_id) || new Set();
    truths.add(row.ground_truth_entity_id);
    clusterToTruths.set(row.predicted_cluster_id, truths);
  }
  const truths = truthToClusters.size;
  const clusters = clusterToTruths.size;
  return {
    status: truths ? 'measured_on_labeled_fixture' : 'not_available',
    ground_truth_entities: truths,
    predicted_clusters: clusters,
    split_entities: [...truthToClusters.values()].filter((keys) => keys.size > 1).length,
    merged_clusters: [...clusterToTruths.values()].filter((ids) => ids.size > 1).length,
    clusters_per_ground_truth: truths ? Number((clusters / truths).toFixed(4)) : null,
  };
}

function fixturePlateMetrics(rows) {
  const labeled = rows.filter((row) => row.entity_kind === 'vehicle'
    && (row.review_state === 'accepted' || row.review_state === 'rejected')
    && normalizedPlate(row.candidate_plate)
    && normalizedPlate(row.reviewed_plate));
  if (!labeled.length) {
    return { status: 'not_available', labeled_reads: 0, exact_matches: 0, exact_match_rate: null, character_accuracy: null };
  }
  let exactMatches = 0;
  let matchingCharacters = 0;
  let totalCharacters = 0;
  for (const row of labeled) {
    const candidate = normalizedPlate(row.candidate_plate);
    const reviewed = normalizedPlate(row.reviewed_plate);
    if (candidate === reviewed) exactMatches += 1;
    const width = Math.max(candidate.length, reviewed.length);
    totalCharacters += width;
    for (let index = 0; index < width; index += 1) {
      if (candidate[index] !== undefined && candidate[index] === reviewed[index]) matchingCharacters += 1;
    }
  }
  return {
    status: 'measured_on_labeled_fixture',
    labeled_reads: labeled.length,
    exact_matches: exactMatches,
    exact_match_rate: Number((exactMatches / labeled.length).toFixed(4)),
    character_accuracy: totalCharacters ? Number((matchingCharacters / totalCharacters).toFixed(4)) : null,
  };
}

export function evaluateFixture(rows) {
  if (!Array.isArray(rows)) throw new TypeError('Fixture input must be an array');
  const reviewedPrecision = precisionForRows(rows);
  return {
    schema_version: 1,
    scope: 'synthetic_fixture_only',
    reviewed_precision: reviewedPrecision,
    plate_exact_match: fixturePlateMetrics(rows),
    person_identity: fixtureIdentityMetrics(rows),
    limitations: [
      'Synthetic results verify metric calculations, not real-world model accuracy.',
      'Only human-decided rows contribute to precision; inconclusive and pending decisions are reported separately.',
      'Identity fragmentation is measured only where a labeled fixture supplies both ground truth and predicted cluster ids.',
    ],
  };
}

function aggregateAccuracySummary(summary) {
  if (!summary || !Array.isArray(summary.groups) || !Array.isArray(summary.missed_detections)) {
    throw new TypeError('cctv_accuracy_summary returned an unsupported response');
  }
  const groups = summary.groups.map((group) => {
    if (!ENTITY_KINDS.includes(group.entity_kind)) throw new TypeError('cctv_accuracy_summary returned an unsupported entity kind');
    const accepted = Number(group.accepted);
    const rejected = Number(group.rejected);
    const inconclusive = Number(group.inconclusive);
    const pending = Number(group.pending);
    if (![accepted, rejected, inconclusive, pending].every((value) => Number.isInteger(value) && value >= 0)) {
      throw new TypeError('cctv_accuracy_summary returned invalid review counts');
    }
    const decided = accepted + rejected;
    return {
      entity_kind: group.entity_kind,
      engine_version: String(group.engine_version || 'unknown'),
      detector_model: String(group.detector_model || 'unknown'),
      review_basis: String(group.review_basis || 'unknown'),
      confidence_band: String(group.confidence_band || 'unknown'),
      accepted,
      rejected,
      inconclusive,
      pending,
      decided,
      precision: decided ? Number((accepted / decided).toFixed(4)) : null,
      precision_lower_bound: decided ? wilsonLowerBound(accepted, decided) : null,
      calibrated: group.calibrated === true,
    };
  });
  const byKind = Object.fromEntries(ENTITY_KINDS.map((kind) => {
    const matches = groups.filter((group) => group.entity_kind === kind);
    const counts = matches.reduce((total, group) => ({
      accepted: total.accepted + group.accepted,
      rejected: total.rejected + group.rejected,
      inconclusive: total.inconclusive + group.inconclusive,
      pending: total.pending + group.pending,
    }), { accepted: 0, rejected: 0, inconclusive: 0, pending: 0 });
    const decided = counts.accepted + counts.rejected;
    return [kind, {
      ...counts,
      decided,
      precision: decided ? Number((counts.accepted / decided).toFixed(4)) : null,
      precision_lower_bound: decided ? wilsonLowerBound(counts.accepted, decided) : null,
      calibrated_groups: matches.filter((group) => group.calibrated).length,
      total_groups: matches.length,
    }];
  }));
  const missed = summary.missed_detections.reduce((total, item) => {
    if (!ENTITY_KINDS.includes(item.entity_kind)) throw new TypeError('cctv_accuracy_summary returned an unsupported missed-detection kind');
    for (const field of ['open', 'confirmed_missed', 'not_missed']) {
      const value = Number(item[field]);
      if (!Number.isInteger(value) || value < 0) throw new TypeError('cctv_accuracy_summary returned invalid missed-detection counts');
      total[field] += value;
    }
    return total;
  }, { open: 0, confirmed_missed: 0, not_missed: 0 });
  return {
    schema_version: 1,
    scope: 'single_organization_aggregate',
    since: summary.since || null,
    calibration_minimum_decisions: Number(summary.calibration_minimum_decisions) || 30,
    reviewed_precision_by_kind: byKind,
    reviewed_precision_by_group: groups,
    missed_detection_reports: { ...missed, recall: null },
    plate_exact_match: {
      status: 'not_available',
      reason: 'The live summary contains review counts, not adjudicated plate strings or ground-truth labels.',
    },
    person_identity: {
      status: 'not_available',
      reason: 'The live summary contains no ground-truth person labels or profile-to-person mappings.',
    },
    limitations: [
      'This report is aggregate and organization-scoped; no observation rows, names, images, plate strings or embeddings are returned.',
      'Missed-detection reports are not a complete recall denominator, so recall is not inferred.',
      'Live plate exact-match and person fragmentation require a governed, human-labeled evaluation set.',
    ],
  };
}

export async function fetchLiveSummary({ supabaseUrl, serviceRoleKey, organizationId, since, fetchImpl = fetch }) {
  if (!supabaseUrl || !serviceRoleKey) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for --live');
  if (!UUID.test(organizationId || '')) throw new Error('--organization-id or CCTV_EVAL_ORGANIZATION_ID must be a UUID');
  if (since !== undefined && (!Number.isFinite(Date.parse(since)) || !/[zZ]|[+-]\d{2}:\d{2}$/.test(since))) {
    throw new Error('--since must be an ISO timestamp with an explicit timezone');
  }
  let url;
  try {
    url = new URL(supabaseUrl);
  } catch {
    throw new Error('SUPABASE_URL must be a valid HTTPS URL');
  }
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('SUPABASE_URL must be HTTPS and contain no credentials');
  const response = await fetchImpl(new URL('/rest/v1/rpc/cctv_accuracy_summary', url), {
    method: 'POST',
    redirect: 'error',
    cache: 'no-store',
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ p_organization_id: organizationId, p_since: since || null }),
  });
  if (!response.ok) throw new Error(`cctv_accuracy_summary failed with HTTP ${response.status}`);
  const summary = await response.json();
  return aggregateAccuracySummary(summary);
}

const FIXTURE = [
  { entity_kind: 'person', review_state: 'accepted', ground_truth_entity_id: 'p1', predicted_cluster_id: 'a' },
  { entity_kind: 'person', review_state: 'accepted', ground_truth_entity_id: 'p1', predicted_cluster_id: 'a' },
  { entity_kind: 'person', review_state: 'accepted', ground_truth_entity_id: 'p2', predicted_cluster_id: 'b' },
  { entity_kind: 'person', review_state: 'accepted', ground_truth_entity_id: 'p3', predicted_cluster_id: 'c' },
  { entity_kind: 'person', review_state: 'accepted', ground_truth_entity_id: 'p3', predicted_cluster_id: 'd' },
  { entity_kind: 'person', review_state: 'accepted', ground_truth_entity_id: 'p4', predicted_cluster_id: 'c' },
  { entity_kind: 'person', review_state: 'rejected' },
  { entity_kind: 'vehicle', review_state: 'accepted', candidate_plate: 'ABC123', reviewed_plate: 'ABC123' },
  { entity_kind: 'vehicle', review_state: 'accepted', candidate_plate: 'ABCI23', reviewed_plate: 'ABC123' },
  { entity_kind: 'vehicle', review_state: 'rejected', candidate_plate: 'WXY789', reviewed_plate: 'WXY789' },
  { entity_kind: 'vehicle', review_state: 'unreviewed' },
  { entity_kind: 'animal', review_state: 'accepted' },
  { entity_kind: 'animal', review_state: 'uncertain' },
];

function parseArgs(args) {
  const values = new Map();
  const flags = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--fixture' || arg === '--live' || arg === '--help') {
      if (flags.has(arg)) throw new Error(`Duplicate option: ${arg}`);
      flags.add(arg);
    } else if (arg === '--organization-id' || arg === '--since') {
      if (values.has(arg) || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`${arg} requires one value and may be used once`);
      values.set(arg, args[index + 1]);
      index += 1;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (flags.has('--help')) return { help: true };
  if (flags.has('--fixture') === flags.has('--live')) throw new Error('Choose exactly one of --fixture or --live');
  if (flags.has('--fixture') && (values.has('--organization-id') || values.has('--since'))) {
    throw new Error('--organization-id and --since apply only to --live');
  }
  if (flags.has('--live') && values.has('--since') && !Number.isFinite(Date.parse(values.get('--since')))) {
    throw new Error('--since must be an ISO timestamp');
  }
  return {
    mode: flags.has('--fixture') ? 'fixture' : 'live',
    organizationId: values.get('--organization-id') || process.env.CCTV_EVAL_ORGANIZATION_ID,
    since: values.get('--since'),
  };
}

function usage() {
  return [
    'Usage:',
    '  node scripts/cctv-recognition-eval.mjs --fixture',
    '  SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/cctv-recognition-eval.mjs --live --organization-id <uuid> [--since <ISO timestamp>]',
    '',
    'Live mode calls the read-only, organization-scoped cctv_accuracy_summary RPC and emits aggregates only.',
  ].join('\n');
}

async function main(args) {
  const options = parseArgs(args);
  if (options.help) {
    console.log(usage());
    return;
  }
  const report = options.mode === 'fixture'
    ? evaluateFixture(FIXTURE)
    : await fetchLiveSummary({
      supabaseUrl: process.env.SUPABASE_URL,
      serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      organizationId: options.organizationId,
      since: options.since,
    });
  console.log(JSON.stringify(report, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`CCTV recognition evaluation failed: ${error.message}`);
    process.exitCode = 1;
  });
}
