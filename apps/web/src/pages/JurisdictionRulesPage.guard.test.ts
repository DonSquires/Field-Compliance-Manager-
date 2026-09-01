import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src/pages/JurisdictionRulesPage.tsx'), 'utf8');
const zoneSource = readFileSync(resolve(process.cwd(), 'src/pages/ZoneDetailPage.tsx'), 'utf8');
const adminShell = readFileSync(resolve(process.cwd(), 'src/shells/AdminShell.tsx'), 'utf8');
const fieldOps = readFileSync(resolve(process.cwd(), 'src/pages/FieldOperationsPage.tsx'), 'utf8');

describe('JurisdictionRulesPage', () => {
  it('covers every module_key in the client_site_patrol_config CHECK constraint, not just one vertical', () => {
    for (const key of ['freedom_camping', 'parking_enforcement', 'noise_control', 'biosecurity', 'smoke_complaints', 'static_guarding', 'access_control', 'ems', 'alarm_response', 'welfare_check', 'general_patrol']) {
      expect(source).toContain(`'${key}'`);
    }
  });

  it('validates the rules JSON before writing', () => {
    expect(source).toContain('JSON.parse(form.rulesText)');
    expect(source).toContain("setError('Rules must be valid JSON.')");
  });

  it('writes directly to jurisdiction_rule_sets (RLS now permits org-admin writes)', () => {
    expect(source).toContain("from('jurisdiction_rule_sets').insert(");
    expect(source).toContain("from('jurisdiction_rule_sets')\n        .update(");
    expect(source).toContain("from('jurisdiction_rule_sets').delete(");
  });

  it('is wired as a field-ops sub-area reachable from the operations landing grid', () => {
    expect(adminShell).toContain("'jurisdiction-rules'");
    expect(adminShell).toContain("case 'jurisdiction-rules':");
    expect(adminShell).toContain('<JurisdictionRulesPage />');
    expect(fieldOps).toContain("area: 'jurisdiction-rules'");
  });
});

describe('ZoneDetailPage bylaw authoring', () => {
  it('lets an admin edit the zone bylaw clause/source and link a jurisdiction rule set directly', () => {
    expect(zoneSource).toContain("from('location_zones')");
    expect(zoneSource).toContain('bylaw_clause: bylawForm.bylaw_clause.trim() || null');
    expect(zoneSource).toContain('jurisdiction_rule_set_id: ruleSetId || null');
  });
});
