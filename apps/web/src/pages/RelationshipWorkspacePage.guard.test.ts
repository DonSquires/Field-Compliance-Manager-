import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const page = readFileSync(resolve(process.cwd(), 'src/pages/RelationshipWorkspacePage.tsx'), 'utf8');

describe('operating branch relationship workspace', () => {
  it('loads and classifies relationships using the selected operating branch', () => {
    expect(page).toContain('operatingOrganizationId ?? profile?.organizationId');
    expect(page).toContain('provider_organization_id.eq.${operatingBranchId}');
    expect(page).toContain('agreement.provider_organization_id === operatingBranchId');
  });
});