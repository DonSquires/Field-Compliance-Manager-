export const VEHICLE_SEARCH_POPOUT_NAME = 'fcm-vehicle-search';

export function vehicleSearchPopoutUrl(plate?: string | null): string {
  const params = new URLSearchParams({ area: 'vehicle-search', popout: '1' });
  const trimmed = plate?.trim();
  if (trimmed) params.set('plate', trimmed);
  return `/admin/field-ops?${params.toString()}`;
}

/**
 * Opens (or re-focuses) the single vehicle-search window so it can sit on another monitor.
 * `noopener` is deliberately not passed: it would stop the browser copying sessionStorage,
 * which carries the "Working in" organisation. The opener link is cut after opening instead.
 */
export function openVehicleSearchPopout(plate?: string | null): boolean {
  const width = Math.min(window.screen.availWidth || 1100, 1100);
  const height = Math.min(window.screen.availHeight || 900, 900);
  const popup = window.open(vehicleSearchPopoutUrl(plate), VEHICLE_SEARCH_POPOUT_NAME, `popup=yes,width=${width},height=${height},left=120,top=60`);
  if (!popup) return false;
  popup.opener = null;
  popup.focus();
  return true;
}
