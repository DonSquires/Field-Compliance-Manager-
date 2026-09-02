import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src/pages/BuilderControlRoomPage.tsx'), 'utf8');
const relay = readFileSync(resolve(process.cwd(), '../../supabase/functions/bob-builder-control-room/index.ts'), 'utf8');

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
    expect(source).toContain('const expired = new Date(approval.expires_at).getTime() <= Date.now();');
    expect(source).toContain('Approval expired');
    expect(source).toContain('A new evidence review is required.');
    expect(source).toContain('approval.reviewed_artifact_ids.includes(artifact.id)');
    expect(source).toContain('Immutable evidence under review');
    expect(source).toContain('const evidenceComplete = approval.reviewed_artifact_ids.length > 0 && reviewedArtifacts.length === approval.reviewed_artifact_ids.length;');
    expect(source).toContain('Evidence unavailable');
    expect(source).toContain('!evidenceComplete');
    expect(source).toContain('Builder job workspace');
    expect(source).toContain('Immutable task brief');
    expect(source).toContain('Verified artifacts');
    expect(source).toContain('Durable execution timeline');
    expect(source).toContain("action: 'read_artifact'");
    expect(source).toContain('Selected artifact content');
    expect(source).toContain('<BobPanel');
    expect(source).toContain("surface: 'builder_control_room'");
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
    expect(relay).toContain('ARTIFACT_PREVIEW_LIMIT_BYTES');
    expect(relay).toContain("admin.storage.from('builder-artifacts').download");
    expect(relay).toContain("admin.from('builder_job_steps')");
    expect(relay).not.toContain('storage_location: artifact.storage_location');
  });
});
