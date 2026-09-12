import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260912135000_finance_external_connection_wizard.sql'), 'utf8');
const anzMigration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260912137000_anz_bank_connection_adapter.sql'), 'utf8');
const component = readFileSync(resolve(process.cwd(), 'src/components/FinanceConnectionWizard.tsx'), 'utf8');
const page = readFileSync(resolve(process.cwd(), 'src/pages/FinanceConnectionsPage.tsx'), 'utf8');

describe('finance external connection wizard', () => {
  it('supports governed IRD and bank connection requests without storing credentials', () => {
    expect(migration).toContain('finance_external_connection_requests');
    expect(migration).toContain("provider_type IN ('ird','bank')");
    expect(migration).toContain("'credentials_collected', false");
    expect(migration).toContain('request_finance_external_connection');
    expect(migration).toContain('consent_confirmed');
    expect(anzMigration).toContain('request_anz_bank_connection');
    expect(anzMigration).toContain("bank_name ILIKE '%ANZ%'");
  });

  it('keeps requested data scoped and human-authorised', () => {
    expect(migration).toContain('human_approval_required');
    expect(migration).toContain('data_minimised');
    expect(migration).toContain('finance_external_connection_requested');
    expect(migration).toContain('is_admin_for_org(v_org)');
  });

  it('warns owners never to enter passwords or tokens and uses the governed RPC', () => {
    expect(component).toContain('We never ask for online-banking passwords, IRD passwords, MFA codes, or access tokens');
    expect(component).toContain("supabase.rpc('request_finance_external_connection'");
    expect(component).toContain("supabase.rpc('request_anz_bank_connection'");
    expect(component).toContain("supabase.functions.invoke('finance-akahu-start'");
    expect(component).toContain('window.location.assign(authData.authorization_url)');
    expect(component).toContain('ANZ bank account');
    expect(component).toContain('approved provider');
    expect(page).toContain('<FinanceConnectionWizard />');
  });
});
