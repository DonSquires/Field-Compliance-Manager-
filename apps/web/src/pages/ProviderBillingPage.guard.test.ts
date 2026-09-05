import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const page = readFileSync(resolve(process.cwd(), 'src/pages/ProviderBillingPage.tsx'), 'utf8');

describe('Iron Eagle platform billing', () => {
  it('keeps Layer 1 provider subscription lifecycle governed and distinct from client pricing', () => {
    expect(page).toContain("rpc('manage_provider_module_subscription_status'");
    expect(page).not.toMatch(/from\('org_module_subscriptions'\)\.update/);
    expect(page).toContain('Iron Eagle Platform Billing');
    expect(page).toContain('This is not client service pricing.');
    expect(page).toContain('Platform cost');
    expect(page).toContain('Catalog list price');
    expect(page).toContain('const moduleLabel');
  });
});