export type WebsiteAnalyticsPeriod = 7 | 30 | 90;

export interface WebsiteAnalyticsDailyTotal {
  viewed_on: string;
  page_views: number;
}

export interface WebsiteAnalyticsPageTotal {
  page_path: string;
  page_views: number;
}

export interface WebsiteAnalyticsRegionTotal {
  country_code: string;
  region_code: string;
  page_views: number;
}

export interface WebsiteAnalyticsSummary {
  total_page_views: number;
  daily: WebsiteAnalyticsDailyTotal[];
  pages: WebsiteAnalyticsPageTotal[];
  regions: WebsiteAnalyticsRegionTotal[];
}

export function getWebsiteAnalyticsDateRange(
  days: WebsiteAnalyticsPeriod,
  now: Date = new Date(),
): { from: string; to: string } {
  const to = now.toISOString().slice(0, 10);
  const start = new Date(`${to}T00:00:00.000Z`);
  start.setUTCDate(start.getUTCDate() - days + 1);
  return { from: start.toISOString().slice(0, 10), to };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function parseDaily(value: unknown): WebsiteAnalyticsDailyTotal[] | null {
  if (!Array.isArray(value)) return null;
  const result: WebsiteAnalyticsDailyTotal[] = [];
  for (const entry of value) {
    if (!isRecord(entry)
      || !hasExactKeys(entry, ['page_views', 'viewed_on'])
      || typeof entry.viewed_on !== 'string'
      || !/^\d{4}-\d{2}-\d{2}$/.test(entry.viewed_on)
      || !isCount(entry.page_views)) return null;
    result.push({ viewed_on: entry.viewed_on, page_views: entry.page_views });
  }
  return result;
}

function parsePages(value: unknown): WebsiteAnalyticsPageTotal[] | null {
  if (!Array.isArray(value)) return null;
  const result: WebsiteAnalyticsPageTotal[] = [];
  for (const entry of value) {
    if (!isRecord(entry)
      || !hasExactKeys(entry, ['page_path', 'page_views'])
      || typeof entry.page_path !== 'string'
      || !entry.page_path.startsWith('/')
      || !isCount(entry.page_views)) return null;
    result.push({ page_path: entry.page_path, page_views: entry.page_views });
  }
  return result;
}

function parseRegions(value: unknown): WebsiteAnalyticsRegionTotal[] | null {
  if (!Array.isArray(value)) return null;
  const result: WebsiteAnalyticsRegionTotal[] = [];
  for (const entry of value) {
    if (!isRecord(entry)
      || !hasExactKeys(entry, ['country_code', 'page_views', 'region_code'])
      || typeof entry.country_code !== 'string'
      || !/^[A-Z]{2}$/.test(entry.country_code)
      || typeof entry.region_code !== 'string'
      || !/^[A-Z0-9-]{1,15}$/.test(entry.region_code)
      || !isCount(entry.page_views)) return null;
    result.push({
      country_code: entry.country_code,
      region_code: entry.region_code,
      page_views: entry.page_views,
    });
  }
  return result;
}

export function parseWebsiteAnalyticsSummary(value: unknown): WebsiteAnalyticsSummary | null {
  if (!isRecord(value)
    || !hasExactKeys(value, ['daily', 'pages', 'regions', 'total_page_views'])
    || !isCount(value.total_page_views)) return null;
  const daily = parseDaily(value.daily);
  const pages = parsePages(value.pages);
  const regions = parseRegions(value.regions);
  if (!daily || !pages || !regions) return null;
  return { total_page_views: value.total_page_views, daily, pages, regions };
}
