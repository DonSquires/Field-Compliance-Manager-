const TERMINAL_STATUSES = new Set(['deployed', 'failed', 'cancelled']);
const ORPHAN_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const { isHealthTestPath } = require('./supabase/functions/_shared/builder-repository-context');

function historicalHealthResolution(job, {
  currentMainSha, currentMainHealthPassed, activeExecution = false, verifiedFiles = [],
} = {}) {
  if (!job?.id || !['failed', 'cancelled'].includes(job.status)
    || job.autopilot_source !== 'main_monitor' || job.autopilot_state === 'done'
    || activeExecution || job.workspace_branch || job.workspace_pull_request_url
    || currentMainHealthPassed !== true || !/^[a-f0-9]{40}$/.test(String(currentMainSha || ''))
    || !/^[a-f0-9]{40}$/.test(String(job.source_main_health_sha || ''))
    || job.source_main_health_sha === currentMainSha) return null;
  const files = job.source_main_health_files;
  if (!Array.isArray(files) || !files.length || files.length > 8
    || files.some(file => !isHealthTestPath(file) || !verifiedFiles.includes(file))) return null;
  return {
    outcome: 'resolved_historical_main_health',
    reason: `Current main ${currentMainSha} passed all health steps and still contains this repair's failing test files; the historical ${job.status} status is preserved.`,
  };
}

function jobHygieneDecision(job, {
  currentMainSha,
  currentMainHealthPassed,
  activeExecution = false,
  pendingApproval = false,
  now = Date.now(),
  orphanRetentionMs = ORPHAN_RETENTION_MS,
} = {}) {
  if (!job?.id || TERMINAL_STATUSES.has(job.status)) return null;
  if (activeExecution || job.workspace_branch || job.workspace_pull_request_url) return null;

  if (job.autopilot_state === 'done') {
    return {
      outcome: 'completed_autopilot',
      reason: 'Bob had already recorded this job as done; its nonterminal queue status was stale.',
    };
  }

  if (
    job.autopilot_source === 'main_monitor'
    && currentMainHealthPassed === true
    && /^[a-f0-9]{40}$/i.test(String(currentMainSha || ''))
    && job.source_main_health_sha !== currentMainSha
  ) {
    return {
      outcome: 'superseded_main_health',
      reason: `Current main ${currentMainSha} passed the complete health profile; this older workspace-free repair is superseded.`,
    };
  }

  const updatedAt = Date.parse(job.updated_at || job.created_at || '');
  const manuallyOrphaned = !job.autopilot_requested_by
    && !job.autopilot_source
    && !job.autopilot_state
    && !pendingApproval
    && Number.isFinite(updatedAt)
    && now - updatedAt >= orphanRetentionMs;
  if (manuallyOrphaned) {
    return {
      outcome: 'inactive_orphan',
      reason: `This unowned job had no workspace, approval, or execution activity for at least ${Math.round(orphanRetentionMs / 86_400_000)} days.`,
    };
  }

  return null;
}

module.exports = { ORPHAN_RETENTION_MS, TERMINAL_STATUSES, jobHygieneDecision, historicalHealthResolution };
