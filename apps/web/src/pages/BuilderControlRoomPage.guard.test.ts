import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Normalised to LF: an assertion below embeds a literal '\n' for a multi-line pattern, but git
// on Windows checks these files out as CRLF - an exact substring match would otherwise fail even
// when every individual token it checks for is genuinely present.
const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8').replace(/\r\n/g, '\n');
const source = read('src/pages/BuilderControlRoomPage.tsx');
const relay = read('../../supabase/functions/bob-builder-control-room/index.ts');

describe('Builder control room boundary', () => {
  it('uses the authenticated Edge Function instead of control-plane credentials', () => {
    expect(source).toContain("functions.invoke('bob-builder-control-room'");
    expect(source).not.toContain('BOB_ADMIN_TOKEN');
    expect(source).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
  });

  it('offers explicit scope and review policy controls', () => {
    expect(source).toContain('frontend_required');
    expect(source).toContain('backend_required');
    expect(source).toContain('independent_ai');
    expect(source).toContain("requestedAction: 'prepare_change'");
    expect(source).toContain("targetEnvironment: 'development'");
    expect(source).toContain('requested_action: form.requestedAction');
    expect(source).toContain('target_environment: form.targetEnvironment');
    expect(source).toContain('Requested action');
    expect(source).toContain('Target environment');
    expect(source).toContain("targetEnvironment === 'production' ? 'prepare_release'");
    expect(source).toContain("disabled={form.targetEnvironment === 'production'}");
    expect(source).toContain("advance('run')");
    expect(source).toContain('frontend_files: fileList(frontendFiles)');
    expect(source).toContain('backend_files: fileList(backendFiles)');
    expect(source).toContain('reviewer_model_name: reviewerModel.trim()');
    expect(source).toContain("action: 'decide_approval'");
    expect(source).toContain('Human approval required');
    expect(source).toContain('Review rationale');
    expect(source).toContain("decideApproval(approval, 'approved')");
    expect(source).not.toContain('approval.expires_at');
    expect(source).toContain('approval.reviewed_artifact_ids.includes(artifact.id)');
    expect(source).toContain('Immutable evidence under review');
    expect(source).toContain('const evidenceComplete = approval.reviewed_artifact_ids.length > 0 && reviewedArtifacts.length === approval.reviewed_artifact_ids.length;');
    expect(source).toContain('Evidence unavailable');
    expect(source).toContain('disabled={!evidenceComplete');
    expect(source).toContain('Builder job workspace');
    expect(source).toContain('Immutable task brief');
    expect(source).toContain('Verified artifacts');
    expect(source).toContain('Durable execution timeline');
    expect(source).toContain('Commit-pinned build and live evidence');
    expect(source).toContain("action: 'context_snapshot'");
    expect(source).toContain("action: 'refresh_atlas'");
    expect(source).toContain('Refresh Atlas');
    expect(source).toContain("action: 'read_artifact'");
    expect(source).toContain('Selected artifact content');
    expect(source).toContain("action: 'create_workspace'");
    expect(source).toContain('Create workspace');
    expect(source).toContain("action: 'commit_verified_patch'");
    expect(source).toContain('Commit verified patch');
    expect(source).toContain("action: 'publish_workspace'");
    expect(source).toContain('Publish for review');
    expect(source).toContain("action: 'create_pull_request'");
    expect(source).toContain('Create pull request');
    expect(source).toContain("action: 'create_followup'");
    expect(source).toContain('Continue on this branch');
    expect(source).toContain('Continue build');
    expect(source).toContain('<BobPanel');
    expect(source).toContain('mode="builder"');
    expect(source).toContain("surface: 'builder_control_room'");
  });

  it('renders partial historical jobs without calling string methods on missing fields', () => {
    expect(source).toContain("const plainWords = (value: unknown, fallback = 'Not recorded')");
    expect(source).toContain('snapshot?.job?.id === selectedId ? snapshot.job');
    expect(source).toContain('Review: {plainWords(selectedJob.code_review_mode)}');
    expect(source).toContain('{plainWords(selectedJob.requested_action)} for {plainWords(selectedJob.target_environment)}');
  });

  it('counts only unresolved work as an issue and keeps terminal history in its own tabs', () => {
    expect(source).toContain("const NON_ACTIONABLE_ISSUE_STATUSES = new Set(['release_ready', 'deployed', 'failed', 'cancelled'])");
    expect(source).toContain('const issueJobs = jobs.filter(isActionableIssue).length');
    expect(source).toContain('if (!isActionableIssue(job)) return false');
    expect(source).toContain('No actionable issues');
  });

  it('offers confirmed, reasoned cancellation only for active selected jobs and refreshes on success', () => {
    expect(source).toContain("!['deployed', 'failed', 'cancelled'].includes(selectedJob.status)");
    expect(source).toContain('Cancellation reason<textarea');
    expect(source).toContain('required disabled={Boolean(busy)}');
    expect(source).toContain('disabled={Boolean(busy) || !cancellationReason.trim()}');
    expect(source).toContain('if (!window.confirm(`Cancel Builder job');
    expect(source).toContain("await invoke({ action: 'cancel', job_id: jobId, reason });");
    expect(source).toContain('const reason = cancellationReason.trim()');
    expect(source).toContain('const refreshedJobs = await loadList()');
    expect(source).toContain('await loadSnapshot(jobId)');
    expect(source).toContain('setError(cancelError instanceof Error ? cancelError.message');
    expect(source).toContain('const payload = await context.json().catch(() => null)');
    expect(relay).toContain("if (action === 'cancel')");
    expect(relay).toContain("callerClient.rpc('builder_cancel_job', { _job_id: jobId, _reason: reason })");
    expect(relay).toContain('if (error) return json({ error: error.message }, 409)');
  });

  it('keeps relay authority server-side and organization-scoped', () => {
    expect(relay).toContain("Deno.env.get('BOB_ADMIN_TOKEN')");
    expect(relay).toContain('canAccessOrganization');
    expect(relay).toContain("CAN_BUILD.has(role)");
    expect(relay).toContain("Deno.env.get('FCM_API_TOKEN')");
    expect(relay).toContain("action === 'advance' || action === 'run'");
    expect(relay).toContain("Builder execution host is unavailable");
    expect(relay).toContain("failed ? 'failed' : 'listed'");
    expect(relay).toContain("admin.rpc('builder_create_job_v2'");
    expect(relay).toContain('Production jobs require human code review');
    expect(relay).toContain("action === 'decide_approval'");
    expect(relay).toContain("callerClient.rpc(rpc");
    expect(relay).toContain('reviewed_artifact_ids');
    expect(relay).toContain("action === 'read_artifact'");
    expect(relay).toContain("action === 'context_snapshot'");
    expect(relay).toContain("action === 'refresh_atlas'");
    expect(relay).toContain('Atlas refresh is restricted to grand master');
    expect(relay).toContain("action === 'create_workspace'");
    expect(relay).toContain("action === 'commit_verified_patch'");
    expect(relay).toContain("action === 'create_followup'");
    expect(relay).toContain("action === 'publish_workspace'");
    expect(relay).toContain("action === 'create_pull_request'");
    expect(relay).toContain('ARTIFACT_PREVIEW_LIMIT_BYTES');
    expect(relay).toContain("let stage = 'request'");
    expect(relay).toContain("error: 'Builder control room is unavailable', stage");
    expect(relay).toContain('try {\n      await admin.from(\'audit_log\').insert({');
    expect(relay).not.toContain("}).catch(() => {});");
    expect(relay).toContain("admin.storage.from('builder-artifacts').download");
    expect(relay).toContain("admin.from('builder_job_steps')");
    expect(relay).not.toContain('storage_location: artifact.storage_location');
  });
});
