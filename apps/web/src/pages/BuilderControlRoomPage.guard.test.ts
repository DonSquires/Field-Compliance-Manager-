import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src/pages/BuilderControlRoomPage.tsx'), 'utf8');
const relay = readFileSync(resolve(process.cwd(), '../../supabase/functions/bob-builder-control-room/index.ts'), 'utf8');
const chat = readFileSync(resolve(process.cwd(), '../../supabase/functions/onspace-ai-chat/index.ts'), 'utf8');
const caddie = readFileSync(resolve(process.cwd(), '../../supabase/functions/onspace-ai-chat/caddie.ts'), 'utf8');
const videoPerception = readFileSync(resolve(process.cwd(), '../../supabase/functions/bob-perceive-video/index.ts'), 'utf8');

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
    expect(source).toContain("advance('run')");
    expect(source).toContain('frontend_files: fileList(frontendFiles)');
    expect(source).toContain('backend_files: fileList(backendFiles)');
    expect(source).toContain('reviewer_model_name: reviewerModel.trim()');
  });

  it('opens the canonical Bob chat panel with Builder job context', () => {
    expect(source).toContain('onOpenBob?: (context: Record<string, unknown>) => void');
    expect(source).toContain("intent: 'agentic_app_builder'");
    expect(source).toContain("allowedActions: ['create_job', 'inspect_job', 'advance_next_step', 'run_to_human_gate']");
    expect(source).toContain('onClick={openBobBuilder}');
    expect(chat).toContain('function sanitizeFrontendContext');
    expect(chat).toContain('function summarizeCurrentAttachments');
    expect(chat).toContain('attachments_summary: attachmentSummary');
    expect(chat).toContain('const frontendContext = sanitizeFrontendContext(body.context)');
    expect(chat).toContain('frontend_context: frontendContext');
  });

  it('lets Bob invoke Builder through the governed control-room tool only', () => {
    expect(chat).toContain("tool: 'builder_control_room'");
    expect(chat).toContain("case 'builder_control_room':");
    expect(chat).toContain("callFn('bob-builder-control-room'");
    expect(chat).toContain("caps.tier !== 'admiral' && caps.tier !== 'captain'");
    expect(caddie).toContain('builder_control_room:');
    expect(caddie).toContain("builder_control_room: 'bob-builder-control-room'");
    expect(caddie).toContain("if (tool === 'builder_control_room') return caps.tier === 'admiral' || caps.tier === 'captain';");
  });

  it('keeps media perception aligned to the actual Bob attachment schema', () => {
    expect(videoPerception).toContain("select('id, organization_id, file_name, purpose, storage_path')");
    expect(videoPerception).not.toContain('storage_path, metadata');
  });

  it('keeps relay authority server-side and organization-scoped', () => {
    expect(relay).toContain("Deno.env.get('BOB_ADMIN_TOKEN')");
    expect(relay).toContain('canAccessOrganization');
    expect(relay).toContain("CAN_BUILD.has(role)");
    expect(relay).not.toContain("Deno.env.get('FCM_API_TOKEN')");
    expect(relay).not.toContain("Deno.env.get('FCM_API_URL')");
    expect(relay).toContain("action === 'advance' || action === 'run'");
    expect(relay).toContain("Builder execution host is unavailable");
    expect(relay).toContain("failed ? 'failed' : 'listed'");
    expect(relay).toContain("admin.rpc('builder_create_job'");
    expect(relay).toContain("admin.from('builder_job_steps')");
    expect(relay).not.toContain('storage_location: artifact.storage_location');
  });
});
