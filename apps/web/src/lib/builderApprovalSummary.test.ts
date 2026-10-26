import { describe, expect, it } from 'vitest';
import { acceptanceCoverage, approvalMeaning, summarizeSpecification } from './builderApprovalSummary';

const spec = {
  product_brief: { problem: 'Map resets when council boundaries change.', outcome: 'Map keeps its view.', scope: ['Org settings map'] },
  user_roles: [{ role: 'org admin', needs: 'set geofence' }],
  workflow_verification: { before: ['Map shows org'], during: ['Admin adjusts boundary'], after: ['Map stays put'] },
  human_acceptance: { role: 'org admin', route: '/admin/organisation', steps: ['Open settings'], expected_visible_result: 'Map does not reset' },
  delivery_requirements: [{ id: 'r1', source_scope: ['apps/web/src/pages/OrganizationSetupPage.tsx'] }],
  unresolved_questions: ['Which orgs are affected?'],
  assumptions: [],
};

describe('builder approval summary', () => {
  it('never calls missing, malformed or incomplete coverage completed', () => {
    for (const value of [null, {}, { implementation_acceptance: { report: { passed: true } } },
      { implementation_acceptance: { report: { version: 1, passed: true, requirements: [], blockers: [] } } }]) {
      expect(acceptanceCoverage(value).supplied).toBe(false);
      expect(acceptanceCoverage(value).blockers.length).toBeGreaterThan(0);
    }
    const report = { version: 1, passed: false, requirements: [{ requirement_id: 'DR-1', status: 'blocked' }], blockers: ['DR-1: workflow absent'] };
    expect(acceptanceCoverage({ implementation_acceptance: { report } }).blockers).toEqual(report.blockers);
    expect(acceptanceCoverage({ implementation_acceptance: { report: {
      ...report, passed: true, blockers: [], requirements: [{ requirement_id: 'DR-1', status: 'covered' }]
    } } }).supplied).toBe(true);
  });
  it('turns a product specification into a plain plan', () => {
    const summary = summarizeSpecification(JSON.stringify(spec));
    expect(summary?.problem).toBe('Map resets when council boundaries change.');
    expect(summary?.files).toEqual(['apps/web/src/pages/OrganizationSetupPage.tsx']);
    expect(summary?.during).toEqual(['Admin adjusts boundary']);
    expect(summary?.howYouWillCheck.route).toBe('/admin/organisation');
    expect(summary?.questions).toEqual(['Which orgs are affected?']);
  });

  it('unwraps a stored validated_output wrapper', () => {
    expect(summarizeSpecification(JSON.stringify({ validated_output: spec }))?.outcome).toBe('Map keeps its view.');
  });

  it('returns null for content that is not a specification', () => {
    expect(summarizeSpecification('not json')).toBeNull();
    expect(summarizeSpecification('{"other":1}')).toBeNull();
  });

  it('explains what approve and reject mean', () => {
    const meaning = approvalMeaning('specification_review');
    expect(meaning.question).toBe('Is this the right plan?');
    expect(meaning.approveMeans).toMatch(/merge and deployment still need you/);
    expect(approvalMeaning('unknown_kind').question).toBeTruthy();
  });
});
