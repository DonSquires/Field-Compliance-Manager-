import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const webRoot = existsSync(resolve(process.cwd(), 'apps/web/src'))
  ? resolve(process.cwd(), 'apps/web')
  : process.cwd();
const repoRoot = existsSync(resolve(process.cwd(), 'supabase/migrations'))
  ? process.cwd()
  : resolve(process.cwd(), '../..');
const readWeb = (relative: string) => readFileSync(resolve(webRoot, relative), 'utf8');

const component = readWeb('src/components/BomTemplateQuoteAdder.tsx');
const crmPage = readWeb('src/pages/CRMPage.tsx');
const migration = readFileSync(
  resolve(repoRoot, 'supabase/migrations/20260917050000_bom_template_quote_lines.sql'),
  'utf8',
);

describe('BOM template quote adder contract', () => {
  it('only offers templates from the quote provider and carries the selected client site', () => {
    expect(crmPage).toContain('organizationIds={[quoteOperatingProviderId].filter(Boolean)}');
    expect(crmPage).toContain('siteId={lineForm.siteId || null}');
    expect(component).toContain('p_site_id: siteId');
  });

  it('reads active templates and uses the governed, idempotent quote-copy RPC', () => {
    expect(component).toContain("from('workshop_bom_templates')");
    expect(component).toContain(".eq('active', true)");
    expect(component).toContain("supabase.rpc('add_crm_quote_lines_from_bom_template'");
    expect(component).not.toContain("from('quote_lines')");
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.add_crm_quote_lines_from_bom_template(');
    expect(migration).toContain('from public.add_crm_quote_line(');
    expect(migration).toContain('md5(p_client_request_id::text ||');
  });

  it('makes a missing current price visible to the person preparing the quote', () => {
    expect(component).toContain('lines_needing_price');
    expect(crmPage).toContain('no price yet — set a price before sending');
  });
});
