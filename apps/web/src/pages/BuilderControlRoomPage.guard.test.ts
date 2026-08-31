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
    expect(source).toContain("advance('run')");
    expect(source).toContain('frontend_files: fileList(frontendFiles)');
    expect(source).toContain('backend_files: fileList(backendFiles)');
    expect(source).toContain('reviewer_model_name: reviewerModel.trim()');
  });

  it('keeps relay authority server-side and organization-scoped', () => {
    expect(relay).toContain("Deno.env.get('BOB_ADMIN_TOKEN')");
    expect(relay).toContain('canAccessOrganization');
    expect(relay).toContain("CAN_BUILD.has(role)");
    expect(relay).toContain("Deno.env.get('FCM_API_TOKEN')");
    expect(relay).toContain("action === 'advance' || action === 'run'");
    expect(relay).toContain("Builder execution host is unavailable");
    expect(relay).toContain("failed ? 'failed' : 'listed'");
    expect(relay).toContain("admin.rpc('builder_create_job'");
    expect(relay).toContain("admin.from('builder_job_steps')");
    expect(relay).not.toContain('storage_location: artifact.storage_location');
  });
});
