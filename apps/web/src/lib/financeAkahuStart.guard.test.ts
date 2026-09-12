import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const edgeFunction = readFileSync(resolve(process.cwd(), '../../supabase/functions/finance-akahu-start/index.ts'), 'utf8');

describe('Akahu ANZ authorization start', () => {
  it('fails closed without server configuration and never accepts credentials', () => {
    expect(edgeFunction).toContain("Deno.env.get('AKAHU_APP_ID')");
    expect(edgeFunction).toContain("Deno.env.get('AKAHU_REDIRECT_URI')");
    expect(edgeFunction).toContain("/^app_token_[a-z0-9]+$/i.test(akahuAppId)");
    expect(edgeFunction).toContain('Akahu App ID Token or redirect URI is not configured correctly');
    expect(edgeFunction).not.toContain('password');
    expect(edgeFunction).not.toContain('client_secret');
  });

  it('uses short-lived state and the official Akahu authorization endpoint', () => {
    expect(edgeFunction).toContain('oauth.akahu.nz');
    expect(edgeFunction).toContain('response_type: \'code\'');
    expect(edgeFunction).toContain('scope: \'ENDURING_CONSENT\'');
    expect(edgeFunction).toContain('p_state_expires_at');
    expect(edgeFunction).toContain('start_finance_external_oauth');
  });
});
