'use strict';

/**
 * Tell a verification failure caused by the verifier itself (out of memory, killed, timed out,
 * container could not start) apart from one caused by the patch. The first is re-run on the same
 * patch; only the second is handed back to the author as a repair. Job ecfb4dc4 (2026-09-26) had
 * two authoring rounds burned on `tsc` running out of heap in the worker.
 */

const INFRASTRUCTURE_PATTERNS = [
  /heap out of memory/i,
  /Ineffective mark-compacts near heap limit/i,
  /Allocation failed/i,
  /ENOMEM|Cannot allocate memory/i,
  /\bKilled\b/,
  /ETIMEDOUT|timed out after/i,
  /docker: Error response from daemon/i,
  /No space left on device/i,
];
// SIGABRT (134) and SIGKILL (137, the cgroup OOM killer) are never a test outcome.
const INFRASTRUCTURE_EXIT_CODES = new Set([134, 137]);

function classifyVerificationFailure(verification) {
  if (!verification || typeof verification !== 'object') return { infrastructure: false, reason: null };
  if (verification.succeeded === true) return { infrastructure: false, reason: null };
  const commands = Array.isArray(verification.commands) ? verification.commands : Array.isArray(verification.checks) ? verification.checks : [];
  for (const command of commands) {
    if (!command || command.status === 0) continue;
    const text = `${command.stderr || ''}\n${command.stdout || ''}\n${command.error || ''}`;
    const pattern = INFRASTRUCTURE_PATTERNS.find((re) => re.test(text));
    if (pattern || INFRASTRUCTURE_EXIT_CODES.has(Number(command.status))) {
      const label = String(command.command || 'verification command').slice(0, 80);
      const why = pattern ? (text.match(pattern) || [''])[0] : `exit ${command.status}`;
      return { infrastructure: true, reason: `${label}: ${why}`.slice(0, 200) };
    }
  }
  return { infrastructure: false, reason: null };
}

module.exports = { INFRASTRUCTURE_EXIT_CODES, INFRASTRUCTURE_PATTERNS, classifyVerificationFailure };
