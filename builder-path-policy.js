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

module.exports = { PROTECTED_PATTERNS, isMigrationPath, isProtectedPath, laneAllows, laneFor, normalizeRepoPath, protectedReason };
