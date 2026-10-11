#!/usr/bin/env node
/**
 * Perception calibration and human-overturn report.
 *
 * Doctrine: no accuracy claim without a versioned evaluation set and a
 * sufficient reviewed sample. This reports what the live review receipts
 * actually support, and explicitly refuses to publish a rate where the
 * reviewed sample is too small or the confidence is uncalibrated.
 */

import process from 'node:process';

const BASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PAGE_SIZE = 1000;

/** Below this many human decisions, a rate is reported as indicative only. */
export const MIN_REVIEWED_SAMPLE = 30;

/** Decisions that overturn the machine candidate. */
export const OVERTURN_DECISIONS = Object.freeze(['supersede', 'correct', 'reject']);

export function summarize({ envelopes, fields, reviews }) {
  const domainByEnvelope = new Map(envelopes.map((row) => [row.id, row.domain]));
  const fieldById = new Map(fields.map((row) => [row.id, row]));

  const reviewsByField = new Map();
  for (const review of reviews) {
    if (!reviewsByField.has(review.field_id)) reviewsByField.set(review.field_id, []);
    reviewsByField.get(review.field_id).push(review);
  }

  const groups = new Map();
  const ensure = (key, extra) => {
    if (!groups.has(key)) {
      groups.set(key, {
        ...extra,
        candidates: 0,
        reviewed: 0,
        upheld: 0,
        overturned: 0,
        authority_states: {},
        confidence_present: 0,
        calibrated_confidence_present: 0,
      });
    }
    return groups.get(key);
  };

  for (const field of fields) {
    const domain = domainByEnvelope.get(field.envelope_id) ?? 'unknown';
    const group = ensure(`${domain}\u0000${field.field_key}`, { domain, field_key: field.field_key });
    group.candidates += 1;
    group.authority_states[field.authority_state] = (group.authority_states[field.authority_state] ?? 0) + 1;
    if (field.raw_confidence !== null && field.raw_confidence !== undefined) group.confidence_present += 1;
    if (field.calibrated_confidence !== null && field.calibrated_confidence !== undefined) group.calibrated_confidence_present += 1;

    const fieldReviews = reviewsByField.get(field.id) ?? [];
    if (fieldReviews.length === 0) continue;
    group.reviewed += 1;
    const overturned = fieldReviews.some((review) => OVERTURN_DECISIONS.includes(review.decision));
    if (overturned) group.overturned += 1;
    else group.upheld += 1;
  }

  const byDomain = new Map();
  const rows = [...groups.values()].map((group) => {
    const rate = group.reviewed > 0 ? group.overturned / group.reviewed : null;
    const sufficient = group.reviewed >= MIN_REVIEWED_SAMPLE;
    const row = {
      ...group,
      review_coverage: group.candidates > 0 ? group.reviewed / group.candidates : 0,
      overturn_rate: rate,
      sample_sufficient: sufficient,
      claim: group.reviewed === 0
        ? 'no_human_review_yet'
        : sufficient
          ? 'reportable'
          : 'indicative_only_small_sample',
      calibrated: group.calibrated_confidence_present > 0,
    };

    const domainEntry = byDomain.get(group.domain) ?? { domain: group.domain, candidates: 0, reviewed: 0, upheld: 0, overturned: 0, calibrated_confidence_present: 0 };
    domainEntry.candidates += group.candidates;
    domainEntry.reviewed += group.reviewed;
    domainEntry.upheld += group.upheld;
    domainEntry.overturned += group.overturned;
    domainEntry.calibrated_confidence_present += group.calibrated_confidence_present;
    byDomain.set(group.domain, domainEntry);

    return row;
  }).sort((left, right) => right.candidates - left.candidates);

  const domains = [...byDomain.values()].map((entry) => ({
    ...entry,
    review_coverage: entry.candidates > 0 ? entry.reviewed / entry.candidates : 0,
    overturn_rate: entry.reviewed > 0 ? entry.overturned / entry.reviewed : null,
    sample_sufficient: entry.reviewed >= MIN_REVIEWED_SAMPLE,
    calibrated: entry.calibrated_confidence_present > 0,
  })).sort((left, right) => right.candidates - left.candidates);

  const totalReviewed = domains.reduce((sum, entry) => sum + entry.reviewed, 0);
  const totalOverturned = domains.reduce((sum, entry) => sum + entry.overturned, 0);
  const totalCandidates = domains.reduce((sum, entry) => sum + entry.candidates, 0);

  const blockers = [];
  if (domains.every((entry) => !entry.calibrated)) {
    blockers.push('No field carries a calibrated confidence; raw model confidence must not be presented as a probability of correctness.');
  }
  for (const entry of domains) {
    if (!entry.sample_sufficient) {
      blockers.push(`${entry.domain}: ${entry.reviewed} human decisions is below the ${MIN_REVIEWED_SAMPLE}-decision floor, so no accuracy rate may be published.`);
    }
  }

  return {
    totals: {
      domains: domains.length,
      candidates: totalCandidates,
      reviewed: totalReviewed,
      upheld: totalReviewed - totalOverturned,
      overturned: totalOverturned,
      review_coverage: totalCandidates > 0 ? totalReviewed / totalCandidates : 0,
      overturn_rate: totalReviewed > 0 ? totalOverturned / totalReviewed : null,
      sample_sufficient: totalReviewed >= MIN_REVIEWED_SAMPLE,
    },
    domains,
    fields: rows,
    blockers,
    production_accuracy_claim_supported: blockers.length === 0,
  };
}

async function rest(path) {
  const response = await fetch(`${BASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!response.ok) throw new Error(`GET ${path} failed: ${response.status} ${await response.text()}`);
  return response.json();
}

async function fetchAll(table, select) {
  const rows = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await rest(`${table}?select=${select}&limit=${PAGE_SIZE}&offset=${offset}`);
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return rows;
}

function percent(value) {
  return value === null || value === undefined ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

async function main() {
  if (!BASE_URL || !SERVICE_KEY) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');

  const [envelopes, fields, reviews, calibrations] = await Promise.all([
    fetchAll('perception_evidence_envelopes', 'id,domain'),
    fetchAll('perception_evidence_fields', 'id,envelope_id,field_key,authority_state,raw_confidence,calibrated_confidence'),
    fetchAll('perception_evidence_reviews', 'field_id,decision,previous_authority_state,next_authority_state'),
    fetchAll('perception_model_calibrations', 'id,domain,model_name,model_version'),
  ]);

  const report = {
    generated_at: new Date().toISOString(),
    registered_calibrations: calibrations.length,
    ...summarize({ envelopes, fields, reviews }),
  };
  if (calibrations.length === 0) {
    report.blockers.unshift('perception_model_calibrations is empty; no model has a versioned evaluation receipt.');
    report.production_accuracy_claim_supported = false;
  }

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
    return report;
  }

  console.log('Perception calibration and human-overturn report');
  console.log(`Registered model calibrations: ${report.registered_calibrations}`);
  console.log(`Candidates ${report.totals.candidates}; human decisions ${report.totals.reviewed} (coverage ${percent(report.totals.review_coverage)})`);
  console.log(`Upheld ${report.totals.upheld}; overturned ${report.totals.overturned}; overturn rate ${percent(report.totals.overturn_rate)}`);
  console.log('');
  for (const domain of report.domains) {
    console.log(`  ${domain.domain}: ${domain.candidates} candidates, ${domain.reviewed} reviewed (${percent(domain.review_coverage)}), overturn ${percent(domain.overturn_rate)}${domain.sample_sufficient ? '' : ' [sample below floor]'}`);
  }
  console.log('');
  console.log(`Production accuracy claim supported: ${report.production_accuracy_claim_supported ? 'yes' : 'NO'}`);
  for (const blocker of report.blockers) console.log(`  - ${blocker}`);
  return report;
}

const entry = process.argv[1]?.replace(/\\/g, '/');
if (entry && import.meta.url.endsWith(entry.split('/').pop())) {
  main().catch((error) => {
    console.error(`Calibration report failed: ${error.message}`);
    process.exitCode = 1;
  });
}
