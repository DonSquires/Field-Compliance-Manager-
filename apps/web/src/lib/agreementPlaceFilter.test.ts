import { describe, expect, it } from 'vitest';
import { buildAgreementPlaceFilter } from './agreementPlaceFilter';

describe('buildAgreementPlaceFilter', () => {
  it('filters site-only agreements by site', () => {
    expect(buildAgreementPlaceFilter(['site-1'], [])).toBe('site_id.in.(site-1)');
  });

  it('filters zone-only agreements by zone', () => {
    expect(buildAgreementPlaceFilter([], ['zone-1', 'zone-2'])).toBe('zone_id.in.(zone-1,zone-2)');
  });

  it('includes both sibling place facets for a mixed agreement', () => {
    expect(buildAgreementPlaceFilter(['site-1'], ['zone-1'])).toBe('site_id.in.(site-1),zone_id.in.(zone-1)');
  });

  it('does not narrow results without a loaded place scope', () => {
    expect(buildAgreementPlaceFilter([], [])).toBeNull();
  });
});