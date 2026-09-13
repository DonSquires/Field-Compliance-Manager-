import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const fileSystemPage = readFileSync(resolve(process.cwd(), 'src/pages/FileSystemPage.tsx'), 'utf8');
const financePage = readFileSync(resolve(process.cwd(), 'src/pages/FinanceBureauPage.tsx'), 'utf8');
const rateRulesPage = readFileSync(resolve(process.cwd(), 'src/pages/RateRulesPage.tsx'), 'utf8');
const rosterTargetsPage = readFileSync(resolve(process.cwd(), 'src/pages/RosterTargetsPage.tsx'), 'utf8');
const zoneDetailPage = readFileSync(resolve(process.cwd(), 'src/pages/ZoneDetailPage.tsx'), 'utf8');

describe('org-scope failure guards', () => {
  it('clears loading and exposes a useful unavailable state when tenant context is missing', () => {
    expect(fileSystemPage).toContain("if (!organizationId) {");
    expect(fileSystemPage).toContain('setLoading(false);');
    expect(fileSystemPage).toContain("setError('An active organisation is required before loading files.')");

    expect(financePage).toContain("if (!profile?.organizationId) {");
    expect(financePage).toContain('setLoading(false);');
    expect(financePage).toContain("Organisation access could not be confirmed. Pricing data is unavailable.");

    expect(rateRulesPage).toContain('if (!operatingBranchId) {');
    expect(rateRulesPage).toContain('setLoading(false);');
    expect(rateRulesPage).toContain("setError('Organisation access could not be confirmed. Rate rules are unavailable.');");

    expect(rosterTargetsPage).toContain('if (!org) {');
    expect(rosterTargetsPage).toContain('setLoading(false);');
    expect(rosterTargetsPage).toContain("setError('Organisation access could not be confirmed. Work units are unavailable.');");

    expect(zoneDetailPage).toContain('if (!profile?.organizationId) {');
    expect(zoneDetailPage).toContain('setLoading(false);');
    expect(zoneDetailPage).toContain("setError('Organisation access could not be confirmed. Zone data is unavailable.');");
  });
});
