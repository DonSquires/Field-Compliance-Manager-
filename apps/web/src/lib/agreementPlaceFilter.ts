export function buildAgreementPlaceFilter(siteIds: readonly string[], zoneIds: readonly string[]): string | null {
  const filters = [
    siteIds.length ? `site_id.in.(${siteIds.join(',')})` : null,
    zoneIds.length ? `zone_id.in.(${zoneIds.join(',')})` : null,
  ].filter((filter): filter is string => filter !== null);
  return filters.length ? filters.join(',') : null;
}