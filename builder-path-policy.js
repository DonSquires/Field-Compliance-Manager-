'use strict';

/**
 * Shared path policy for Bob's Builder lane.
 *
 * Bob works like a coding agent across the whole repository, but the protected
 * paths from BOB_DOCTRINE §9 stay human-only: workflows/CI, deployment,
 * dependencies and environment, auth/identity code, secrets, and the
 * regenerated schema snapshot. Migrations may only be ADDED (checked by the
 * lane validators). Everything else is editable and lands in a draft PR.
 */

const path = require('node:path');

const PROTECTED_PATTERNS = [
  /^\.git(\/|$)/,
  /^\.github\/workflows\//,
  /(^|\/)\.env(\.|$)/,
  /(^|\/)\.env\.[^/]*$/,
  /\.(pem|key|pfx|p12|crt|keystore)$/i,
  /^Dockerfile(\.|$)/,
  /(^|\/)Dockerfile(\.[^/]*)?$/,
  /(^|\/)docker-compose[^/]*\.ya?ml$/,
  /^deploy\//,
  /(^|\/)package\.json$/,
  /(^|\/)package-lock\.json$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)yarn\.lock$/,
  /(^|\/)Cargo\.(toml|lock)$/,
  /(^|\/)requirements[^/]*\.txt$/,
  /^supabase\/config\.toml$/,
  /^supabase\/schema\.sql$/,
  /^vercel\.json$/,
  /^apps\/web\/src\/context\/AuthContext\.tsx$/,
  /^apps\/web\/src\/lib\/supabase\.ts$/,
  /^apps\/web\/src\/routing\//,
  /^apps\/web\/src\/components\/SafetyGate\.tsx$/,
  /^apps\/web\/src\/components\/access\//,
  /^supabase\/functions\/_shared\/auth\.ts$/,
];

function normalizeRepoPath(file) {
  const value = String(file ?? '');
  if (!value || value.includes('\0') || value.startsWith('/') || value.startsWith('..')) return null;
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized.startsWith('../') || normalized === '.') return null;
  return normalized;
}

function isProtectedPath(file) {
  const normalized = normalizeRepoPath(file);
  if (!normalized) return true;
  return PROTECTED_PATTERNS.some((pattern) => pattern.test(normalized));
}

function isMigrationPath(file) {
  return /^supabase\/migrations\/\d{14}_[a-z0-9_]+\.sql$/.test(String(file ?? ''));
}

/** Which implementation step may edit a file: the web app belongs to the frontend lane, everything else to the backend lane. */
function laneFor(file) {
  return String(file ?? '').startsWith('apps/web/') ? 'frontend' : 'backend';
}

function laneAllows(lane, file) {
  if (isProtectedPath(file)) return false;
  if (lane === 'frontend') return laneFor(file) === 'frontend';
  if (lane === 'backend') return laneFor(file) === 'backend';
  return false;
}

function protectedReason(file) {
  const normalized = normalizeRepoPath(file);
  if (!normalized) return 'unsafe path';
  if (/^\.github\/workflows\//.test(normalized)) return 'CI workflow (protected path)';
  if (/(^|\/)\.env/.test(normalized) || /\.(pem|key|pfx|p12|crt|keystore)$/i.test(normalized)) return 'environment or secret material (protected path)';
  if (/Dockerfile|docker-compose|^deploy\//.test(normalized)) return 'deployment or environment change (protected path)';
  if (/package(-lock)?\.json$|pnpm-lock|yarn\.lock|Cargo\.(toml|lock)|requirements/.test(normalized)) return 'dependency change (protected path)';
  if (/^supabase\/schema\.sql$/.test(normalized)) return 'regenerated schema snapshot (never hand-edited)';
  if (/AuthContext|lib\/supabase\.ts|routing\/|SafetyGate|components\/access\/|_shared\/auth\.ts/.test(normalized)) return 'auth/identity code (protected path)';
  return 'protected path';
}

// Owner ruling 2026-09-26: "human approval is required for evidential work". Evidential work is
// code that captures, classifies, alters, presents, or delivers records a person may rely on as
// evidence of harm or compliance (FOUNDATION.md: the harmed party and the place of harm are the
// anchor). Bob may build it, but a human — not the autopilot — clears its gates.
const EVIDENTIAL_TERMS = /(evidence|evidential|incident|infring|notice|breach|cctv|camera|capture|motion|video|photo|image|perceive|inference|vision|classif|plate|vehicle|patrol|dispatch|observation|custody|report|audit|signature|signing|noise|parking|biosecurity|welfare|enforcement|complaint|tow(ing)?|warden|inspection)/i;
// Capture and inference surfaces are evidential in their entirety.
const EVIDENTIAL_ROOTS = [/^apps\/mobile\//, /^apps\/sd-card-bridge(-v2)?\//, /^services\/(fcm-capture-inference|fcm-inference|vision)\//, /^deploy\/vision-worker\//, /^desktop-signing-intake\//];
// Bob's own machinery, docs, and tooling are classified by the code they touch, not by their wording.
const NON_EVIDENTIAL_ROOTS = [/^docs\//, /^Build-Plan(\/|\.md$)/, /^scripts\//, /^\.github\//, /^supabase\/functions\/_shared\/builder-/, /^supabase\/functions\/bob-builder-/, /^supabase\/functions\/onspace-ai-chat\//, /^builder-[^/]+\.js$/, /^bob-control-plane-server\.js$/, /^(frontend|backend|security)-worker\.js$/, /^worker-executor\.js$/, /^services\/fcm-api\/src\/bob\//];

function isEvidentialPath(file) {
  const normalized = normalizeRepoPath(file);
  if (!normalized) return false;
  if (EVIDENTIAL_ROOTS.some((pattern) => pattern.test(normalized))) return true;
  if (NON_EVIDENTIAL_ROOTS.some((pattern) => pattern.test(normalized))) return false;
  return EVIDENTIAL_TERMS.test(normalized);
}

function evidentialPathsIn(files) {
  return [...new Set((Array.isArray(files) ? files : []).filter((file) => isEvidentialPath(file)))].sort();
}

/** Repository paths named in free text (a brief) that point at evidential work. */
function evidentialMentions(text) {
  const found = new Set();
  for (const match of String(text ?? '').matchAll(/(?:^|[\s"'`(\[])((?:apps|supabase|services|deploy|desktop-signing-intake)\/[A-Za-z0-9_./-]*[A-Za-z0-9_])/g)) {
    const candidate = match[1].replace(/[.,;:)]+$/, '');
    if (isEvidentialPath(candidate)) found.add(candidate);
  }
  return [...found].sort();
}

module.exports = { EVIDENTIAL_ROOTS, EVIDENTIAL_TERMS, PROTECTED_PATTERNS, evidentialMentions, evidentialPathsIn, isEvidentialPath, isMigrationPath, isProtectedPath, laneAllows, laneFor, normalizeRepoPath, protectedReason };
