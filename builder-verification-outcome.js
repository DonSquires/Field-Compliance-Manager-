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
  /net::ERR_INSUFFICIENT_RESOURCES/i,
];
// SIGABRT (134) and SIGKILL (137, the cgroup OOM killer) are never a test outcome.
const INFRASTRUCTURE_EXIT_CODES = new Set([134, 137]);

function classifyVerificationFailure(verification) {
  if (!verification || typeof verification !== 'object') return { infrastructure: false, baseline: false, reason: null };
  if (verification.succeeded === true) return { infrastructure: false, baseline: false, reason: null };
  const commands = Array.isArray(verification.commands) ? verification.commands : Array.isArray(verification.checks) ? verification.checks : [];
  for (const command of commands) {
    if (!command || command.status === 0) continue;
    const text = `${command.stderr || ''}\n${command.stdout || ''}\n${command.error || ''}`;
    const pattern = INFRASTRUCTURE_PATTERNS.find((re) => re.test(text));
    if (pattern || INFRASTRUCTURE_EXIT_CODES.has(Number(command.status))) {
      const label = String(command.command || 'verification command').slice(0, 80);
      const why = pattern ? (text.match(pattern) || [''])[0] : `exit ${command.status}`;
      return { infrastructure: true, baseline: false, reason: `${label}: ${why}`.slice(0, 200) };
    }
    if (verification.baseline_failure === true && verification.baseline?.proven_same_failure === true) return { infrastructure: false, baseline: true, reason: String(verification.baseline_reason || 'matching baseline failures were verified').slice(0, 400) };
    if (verification.baseline?.also_fails && !verification.baseline.proven_same_failure && !verification.baseline.new_failures?.length) return {
      infrastructure: false, baseline: false, unresolved: true,
      reason: 'Patched and baseline checks both failed without matching failure evidence; attribution is unresolved'
    };
  }
  return { infrastructure: false, baseline: false, reason: null };
}

/**
 * The worker wrote no evidence at all: the container never ran (docker exit 125 — image missing after
 * the VPS's daily image prune, job a0379a3d 2026-09-27 — or a mount/daemon error) or died before its
 * first write. That is the verifier's failure, never the patch's: re-run the same patch, and say why.
 */
function classifyMissingEvidence(result) {
  const code = Number(result?.exitCode);
  const stderr = String(result?.stderr || result?.error || '').trim().split('\n').filter(Boolean).at(-1) || '';
  const detail = stderr ? `: ${stderr.slice(0, 160)}` : '';
  if (code === 125) return { infrastructure: true, baseline: false, reason: `the verifier container could not start (docker exit 125${detail}); check that fcm/bob-worker:current exists on the host` };
  return { infrastructure: true, baseline: false, reason: `the verifier produced no evidence (exit ${Number.isFinite(code) ? code : 'unknown'}${detail})` };
}

module.exports = { INFRASTRUCTURE_EXIT_CODES, INFRASTRUCTURE_PATTERNS, classifyMissingEvidence, classifyVerificationFailure };
