import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src/pages/OrganizationSetupPage.tsx'), 'utf8');

describe('governed organization profile setup', () => {
  it('saves the provider profile through the expected-state RPC', () => {
    expect(source).toContain("supabase.rpc('update_organization_profile'");
    expect(source).toContain('p_expected_updated_at: org.updated_at');
    expect(source).not.toMatch(/\.from\(['"]organizations['"]\)[\s\S]{0,200}\.update\(/);
  });
});
