import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260912139000_akahu_bank_import_ledger.sql'), 'utf8');
const callback = readFileSync(resolve(process.cwd(), '../../supabase/functions/finance-akahu-callback/index.ts'), 'utf8');

describe('Akahu ANZ callback and import', () => {
  it('stores reviewable ANZ transactions with idempotent external IDs', () => {
    expect(migration).toContain('finance_external_bank_transactions');
    expect(migration).toContain('UNIQUE (connection_request_id, external_transaction_id)');
    expect(migration).toContain('record_akahu_import');
    expect(migration).toContain('reconciliation_status');
  });

  it('validates short-lived state and keeps the access token ephemeral', () => {
    expect(callback).toContain("Deno.env.get('AKAHU_APP_SECRET')");
    expect(callback).toContain('oauth_state_hash');
    expect(callback).toContain('oauth_state_expires_at');
    expect(callback).toContain('new Date(requestRow.oauth_state_expires_at).getTime() < Date.now()');
    expect(callback).toContain('record_akahu_import');
    expect(callback).toContain('const providerReference = `akahu:${requestRow.id}`');
    expect(callback).not.toContain('slice(0, 16)');
  });

  it('stops before payments or IRD filing', () => {
    expect(callback).toContain('No payment or IRD submission was made.');
    expect(callback).not.toContain('record_payment_receipt');
    expect(callback).not.toContain('submit');
  });
});
