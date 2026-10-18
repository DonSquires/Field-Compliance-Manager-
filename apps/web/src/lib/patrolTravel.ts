/**
 * patrolTravel.ts — read access to `patrol_travel_km_summary`.
 *
 * The view aggregates real recorded travel distance (officer-recorded "Job Kms",
 * not a GPS estimate) per officer/place/month, unioned from `observations` and
 * `location_events`. It is a read-only reporting aggregate and is deliberately
 * NOT part of the finance/invoicing write pipeline — nothing here proposes,
 * prices, or posts a cost.
 *
 * Two hard rules, both load-bearing:
 *
 * 1. `organizationId` is required on every call. Since 20261019090000 the view
 *    runs with `security_invoker`, so RLS is evaluated per row through
 *    `org_access_allowed()` / `has_location_access()`. An unbounded aggregate
 *    over the full observations history exceeds the statement timeout; an
 *    organisation-scoped read returns in ~180ms. Callers must scope.
 * 2. The month window is always bounded, for the same reason.
 */
import { supabase } from './supabase';

export interface PatrolTravelRow {
  organization_id: string;
  officer_id: string | null;
  zone_id: string | null;
  site_id: string | null;
  /** Month bucket (first day of month) as returned by date_trunc. */
  month: string;
  visit_count: number;
  total_distance_km: number | null;
}

export interface PatrolTravelQuery {
  organizationId: string;
  /** Rolling window in whole months, counted back from the current month. */
  monthsBack: number;
  officerId?: string | null;
  siteId?: string | null;
  zoneId?: string | null;
}

export interface PatrolTravelTotals {
  distanceKm: number;
  visitCount: number;
  officerCount: number;
  placeCount: number;
  monthCount: number;
}

/** First day of the month `monthsBack` months before the current month, as ISO. */
export function travelWindowStart(monthsBack: number, now: Date = new Date()): string {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (monthsBack - 1), 1));
  return start.toISOString();
}

export const TRAVEL_WINDOW_OPTIONS = [3, 6, 12] as const;
export type TravelWindowMonths = (typeof TRAVEL_WINDOW_OPTIONS)[number];

export async function fetchPatrolTravelSummary(query: PatrolTravelQuery): Promise<PatrolTravelRow[]> {
  // ATLAS READS: patrol_travel_km_summary
  let request = supabase
    .from('patrol_travel_km_summary')
    .select('organization_id,officer_id,zone_id,site_id,month,visit_count,total_distance_km')
    .eq('organization_id', query.organizationId)
    .gte('month', travelWindowStart(query.monthsBack))
    .order('month', { ascending: false })
    .limit(1000);

  if (query.officerId) request = request.eq('officer_id', query.officerId);
  if (query.siteId) request = request.eq('site_id', query.siteId);
  if (query.zoneId) request = request.eq('zone_id', query.zoneId);

  const { data, error } = await request;
  if (error) throw error;
  return ((data ?? []) as PatrolTravelRow[]).map((row) => ({
    ...row,
    visit_count: Number(row.visit_count ?? 0),
    total_distance_km: row.total_distance_km === null ? null : Number(row.total_distance_km),
  }));
}

export function summariseTravel(rows: PatrolTravelRow[]): PatrolTravelTotals {
  const officers = new Set<string>();
  const places = new Set<string>();
  const months = new Set<string>();
  let distanceKm = 0;
  let visitCount = 0;
  for (const row of rows) {
    distanceKm += row.total_distance_km ?? 0;
    visitCount += row.visit_count;
    if (row.officer_id) officers.add(row.officer_id);
    if (row.site_id) places.add(row.site_id);
    else if (row.zone_id) places.add(row.zone_id);
    months.add(row.month);
  }
  return {
    distanceKm,
    visitCount,
    officerCount: officers.size,
    placeCount: places.size,
    monthCount: months.size,
  };
}

/** Collapses the per-place rows into one row per officer for the whole window. */
export interface OfficerTravelTotal {
  officerId: string | null;
  distanceKm: number;
  visitCount: number;
}

export function totalsByOfficer(rows: PatrolTravelRow[]): OfficerTravelTotal[] {
  const byOfficer = new Map<string, OfficerTravelTotal>();
  for (const row of rows) {
    const key = row.officer_id ?? '__unattributed__';
    const existing = byOfficer.get(key) ?? { officerId: row.officer_id, distanceKm: 0, visitCount: 0 };
    existing.distanceKm += row.total_distance_km ?? 0;
    existing.visitCount += row.visit_count;
    byOfficer.set(key, existing);
  }
  return [...byOfficer.values()].sort((a, b) => b.distanceKm - a.distanceKm);
}

export function formatMonth(month: string): string {
  const parsed = new Date(month);
  if (Number.isNaN(parsed.getTime())) return month;
  return parsed.toLocaleDateString('en-NZ', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export function formatKm(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return `${value.toLocaleString('en-NZ', { maximumFractionDigits: 1 })} km`;
}
