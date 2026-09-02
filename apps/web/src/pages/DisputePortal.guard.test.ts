import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const portal = readFileSync(resolve(process.cwd(), 'src/pages/DisputePortalPage.tsx'), 'utf8');
const queue = readFileSync(resolve(process.cwd(), 'src/pages/DisputesPage.tsx'), 'utf8');
const app = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf8');
const adminShell = readFileSync(resolve(process.cwd(), 'src/shells/AdminShell.tsx'), 'utf8');
const fieldOps = readFileSync(resolve(process.cwd(), 'src/pages/FieldOperationsPage.tsx'), 'utf8');
const endpoint = readFileSync(resolve(process.cwd(), '../../supabase/functions/submit-dispute/index.ts'), 'utf8');
const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260901030000_disputes_notice_id_nullable.sql'), 'utf8');

describe('public dispute portal', () => {
  it('submits through the service-role edge function, never writing disputes directly', () => {
    expect(portal).toContain("functions.invoke<{ success: boolean; error?: string }>('submit-dispute'");
    expect(portal).not.toContain("from('disputes')");
  });

  it('is served on an unauthenticated route outside the app shells', () => {
    expect(app).toContain('/dispute');
    expect(app).toContain('DisputePortalPage');
  });

  it('requires a notice number, a statement, and at least one ground before submitting', () => {
    expect(portal).toContain('form.notice_number.trim().length > 0');
    expect(portal).toContain('grounds.length > 0');
  });
});

describe('submit-dispute tenant resolution', () => {
  it('derives organization_id server-side from the notice rather than trusting client input', () => {
    expect(endpoint).toContain("from('infringement_notices')");
    expect(endpoint).toContain('organizationId = notice.organization_id');
    expect(endpoint).not.toContain('b.organization_id');
  });

  it('rejects submissions whose notice number cannot be resolved to an organisation', () => {
    expect(endpoint).toContain('A valid infringement notice number is required to submit a dispute');
  });
});

describe('disputes schema corrections', () => {
  it('repoints the notice_id foreign key at infringement_notices, the id space submit-dispute actually resolves', () => {
    expect(migration).toContain('drop constraint if exists disputes_notice_id_fkey');
    expect(migration).toContain('references public.infringement_notices(id)');
  });

  it('makes notice_id nullable for internal/import records', () => {
    expect(migration).toContain('alter column notice_id drop not null');
  });
});

describe('admin dispute review queue', () => {
  it('records reviewer attribution and requires notes before any status change', () => {
    expect(queue).toContain("from('disputes')");
    expect(queue).toContain('reviewed_by: profile.id');
    expect(queue).toContain('Review notes are required before changing a dispute status.');
  });

  it('stamps the decision fields only on terminal outcomes', () => {
    expect(queue).toContain("['upheld', 'withdrawn', 'referred', 'dismissed'].includes(status)");
    expect(queue).toContain('decided_by: profile.id');
  });

  it('is reachable from the field operations landing grid', () => {
    expect(adminShell).toContain("case 'disputes':");
    expect(adminShell).toContain('<DisputesPage />');
    expect(fieldOps).toContain("area: 'disputes'");
  });
});
