import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const connectionWizard = readFileSync(resolve(process.cwd(), 'src/components/FinanceConnectionWizard.tsx'), 'utf8');
const operationsDashboard = readFileSync(resolve(process.cwd(), 'src/components/FinanceOperationsDashboard.tsx'), 'utf8');
const ownerGuide = readFileSync(resolve(process.cwd(), 'src/components/FinanceOwnerGuide.tsx'), 'utf8');

describe('finance org-scope guards', () => {
  it('fails closed instead of spinning forever when org context is absent', () => {
    expect(connectionWizard).toContain("if (!profile?.organizationId) {");
    expect(connectionWizard).toContain('setError(\'Organisation access could not be confirmed. Finance connection setup is unavailable.\');');
    expect(connectionWizard).toContain('setLoading(false);');

    expect(operationsDashboard).toContain("if (!profile?.organizationId) {");
    expect(operationsDashboard).toContain('setError(\'Organisation access could not be confirmed. Finance operations are unavailable.\');');
    expect(operationsDashboard).toContain('setLoading(false);');

    expect(ownerGuide).toContain("if (!profile?.organizationId) {");
    expect(ownerGuide).toContain('setError(\'Organisation access could not be confirmed. Finance guidance is unavailable.\');');
    expect(ownerGuide).toContain('setLoading(false);');
  });
});
