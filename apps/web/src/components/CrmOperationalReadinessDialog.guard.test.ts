import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src/components/CrmOperationalReadinessDialog.tsx'), 'utf8');

describe('CRM enterprise activation readiness dialog', () => {
  it('loads the complete agreement gate through the server-owned RPC', () => {
    expect(source).toContain("supabase.rpc('get_crm_enterprise_readiness'");
    expect(source).toContain('p_agreement_id: agreement.id');
    expect(source).not.toContain("supabase.rpc('get_crm_operational_readiness'");
  });
});