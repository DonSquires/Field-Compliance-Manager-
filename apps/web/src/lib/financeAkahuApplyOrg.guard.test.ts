import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const edge = readFileSync(resolve(process.cwd(), '../../supabase/functions/finance-akahu-apply-org/index.ts'), 'utf8');
const workspace = readFileSync(resolve(process.cwd(), 'src/components/FinanceApplyWorkspace.tsx'), 'utf8');

describe('Akahu Apply organisation verification', () => {
  it('uses the server-only Apply API key and current-org endpoint', () => {
    expect(edge).toContain("Deno.env.get('AKAHU_APPLY_API_KEY')");
    expect(edge).toContain('https://api.apply.akahu.nz/v1');
    expect(edge).toContain('/orgs/current');
    expect(edge).toContain('Authorization: `Bearer ${applyApiKey}`');
    expect(edge).not.toContain('AKAHU_APPLY_API_KEY` }');
  });

  it('requires an authenticated finance administrator and never returns the key', () => {
    expect(edge).toContain('Finance administrator required');
    expect(edge).toContain('api_key_exposed: false');
    expect(edge).not.toContain('return json({ applyApiKey');
  });

  it('reports a missing provider key as a configuration state only after authorising the caller', () => {
    const notConfigured = edge.indexOf("if (!applyApiKey) return json({ configured: false, reason: 'akahu_apply_not_configured'");
    expect(notConfigured).toBeGreaterThan(edge.indexOf('Finance administrator required'));
    expect(edge).not.toContain("'Akahu Apply is not configured yet' }, 503");
    expect(workspace).toContain('providerResult.data?.configured === false');
    expect(workspace).toContain('Akahu Apply is not connected for this platform yet.');
  });
});
