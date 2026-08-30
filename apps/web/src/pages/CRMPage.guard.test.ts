import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const page = readFileSync(resolve(process.cwd(), 'src/pages/CRMPage.tsx'), 'utf8');

describe('governed CRM accounts', () => {
  it('loads account context in batches including real primary contacts', () => {
    expect(page).toContain("from('crm_contacts')");
    expect(page).toContain("from('client_sites')");
    expect(page).toContain("from('quotes')");
    expect(page).not.toContain('for (const acct of (accounts ?? []))');
    expect(page).not.toContain('primary_contact_name: null');
  });

  it('creates draft quotes only through the governed RPC', () => {
    expect(page).toContain("supabase.rpc('create_crm_draft_quote'");
    expect(page).toContain('quoteRequestId.current');
    expect(page).not.toContain(".from('quotes').insert");
  });
});