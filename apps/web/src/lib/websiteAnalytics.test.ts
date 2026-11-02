import { describe, expect, it } from 'vitest';
import { getWebsiteAnalyticsDateRange, parseWebsiteAnalyticsSummary } from './websiteAnalytics';

describe('website analytics data helpers', () => {
  it('uses inclusive UTC date ranges', () => {
    expect(getWebsiteAnalyticsDateRange(7, new Date('2026-11-02T13:00:00.000Z'))).toEqual({
      from: '2026-10-27',
      to: '2026-11-02',
    });
  });

  it('parses aggregate summary records without visitor-level fields', () => {
    expect(parseWebsiteAnalyticsSummary({
      total_page_views: 8,
      daily: [{ viewed_on: '2026-11-02', page_views: 8 }],
      pages: [{ page_path: '/', page_views: 8 }],
      regions: [{ country_code: 'NZ', region_code: 'NELSON', page_views: 5 }],
    })).toEqual({
      total_page_views: 8,
      daily: [{ viewed_on: '2026-11-02', page_views: 8 }],
      pages: [{ page_path: '/', page_views: 8 }],
      regions: [{ country_code: 'NZ', region_code: 'NELSON', page_views: 5 }],
    });
  });

  it('rejects unexpected or unsafe summary data', () => {
    expect(parseWebsiteAnalyticsSummary({
      total_page_views: 1,
      daily: [],
      pages: [{ page_path: 'javascript:alert(1)', page_views: 1 }],
      regions: [],
    })).toBeNull();
    expect(parseWebsiteAnalyticsSummary({
      total_page_views: 1,
      daily: [],
      pages: [],
      regions: [{ country_code: 'NZ', region_code: 'MOTUEKA', page_views: 1, visitor_id: 'unexpected' }],
    })).toBeNull();
  });
});
