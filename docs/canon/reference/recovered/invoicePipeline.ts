// Recovered reference source (NOT compiled or applied here). Origin: GitLab don-squires1/field-compliance-manager
// apps/web/src/lib/invoicePipeline.ts @ Main, read 2026-09-14 via scripts/gitlab-read.mjs. Re-implement against the live schema with tests before use.

/**
 * invoicePipeline.ts — Phase E: invoice pipeline wiring on job completion
 *
 * When a dispatch_job transitions to status='completed', this module:
 *   1. BILLING: creates an invoice_line_items row (existing, unchanged).
 *   2. PAY/COST: resolves pay lines for the PERFORMER via resolvePayLines()
 *      and persists them to dispatch_job_pay_lines (migration 0290).
 *   3. TRAVEL DISTANCE: computes officer-origin -> site distance via
 *      ST_Distance (geography, metres->km) and feeds it as distanceKm
 *      into the pay RateContext so per_km / per_hour_travel rules resolve.
 *   4. LAYER-2 ON-CHARGE: where billing_direction='on_charge', creates
 *      the provider->client on-charge quote_line (migration 0255 quotes).
 *
 * Design reference: docs/design/DISPATCH_ORG_INTEREST_BILLING_CONSOLIDATED.md
 * Section 4.3 (AFTER: billing + on-charge + SLA) + Section 7.3 Phase E.
 *
 * Schema columns verified against docs/db/LIVE_SCHEMA.md (2026-07-24):
 *   invoice_line_items: id, invoice_id, line_number, description, quantity,
 *     unit_price, line_total, created_at, organization_id, source_dispatch_id
 *   invoices: id, organization_id, client_organization_id, service_agreement_id,
 *     invoice_number, invoice_date, due_date, status, subtotal, gst_amount,
 *     total_amount, currency, notes, created_by, site_id
 *   sla_clocks: id, dispatch_job_id, status ('running'|'met'|'breached'),
 *     target_minutes, started_at, arrived_at, elapsed_minutes
 *   dispatch_jobs: organization_id, service_agreement_id, client_site_id,
 *     job_type, sla_minutes, completed_at, dispatch_resource_id,
 *     assigned_to_user_id
 *   dispatch_resources: id, organization_id, location_id, assigned_officer_id
 *   service_agreements: provider_organization_id, client_organization_id
 *   service_agreement_modules: billing_direction ('subscriber'|'on_charge')
 *   rate_rules: organization_id, rule_kind, rate_type, amount, active, etc.
 *   sla_discount_bands: organization_id, service_type (nullable), over_by_minutes_min,
 *     over_by_minutes_max (nullable), discount_pct (0-1)
 *   dispatch_job_pay_lines: migration 0290 (pay/cost sink)
 *   quotes / quote_lines: migration 0255 (Layer-2 on-charge)
 *   client_sites: center_point geometry(Point,4326), gps_lat, gps_lng (0018/0008)
 *   org_rate_settings: pay_policy, overtime_multiplier, double_multiplier, rounding
 *
 * Migration 0287: sla_discount_bands table (additive, idempotent).
 * Migration 0290: dispatch_job_pay_lines + quote_lines.source_dispatch_id.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveRate, resolvePayLines, applyRate, sumLines, round2 } from '@field-compliance/shared';
import type { RateRule, RateRuleKind, RateType, RateContext, DayCategory } from '@field-compliance/shared';

// ── DB row → shared RateRule mapper ──────────────────────────────────────────

interface RateRuleRow {
  id: string;
  organization_id: string;
  rule_kind: RateRuleKind;
  name: string;
  rate_type: RateType;
  amount: number;
  pay_code: string | null;
  gl_account: string | null;
  role_code: string | null;
  region_code: string | null;
  service_type: string | null;
  module_key: string | null;
  job_code: string | null;
  job_type: string | null;
  client_org_id: string | null;
  site_id: string | null;
  zone_id: string | null;
  vehicle_type: string | null;
  distance_min_km: number | null;
  distance_max_km: number | null;
  outside_area: boolean | null;
  day_category: DayCategory | null;
  effective_from: string | null;
  effective_to: string | null;
  priority: number;
  active: boolean;
}

function toRateRule(r: RateRuleRow): RateRule {
  return {
    id: r.id,
    organizationId: r.organization_id,
    ruleKind: r.rule_kind,
    name: r.name,
    rateType: r.rate_type,
    amount: Number(r.amount),
    payCode: r.pay_code,
    glAccount: r.gl_account,
    roleCode: r.role_code,
    regionCode: r.region_code,
    serviceType: r.service_type,
    moduleKey: r.module_key,
    jobCode: r.job_code,
    jobType: r.job_type,
    clientOrgId: r.client_org_id,
    siteId: r.site_id,
    zoneId: r.zone_id,
    vehicleType: r.vehicle_type,
    distanceMinKm: r.distance_min_km,
    distanceMaxKm: r.distance_max_km,
    outsideArea: r.outside_area,
    dayCategory: r.day_category,
    effectiveFrom: r.effective_from,
    effectiveTo: r.effective_to,
    priority: r.priority,
    active: r.active,
  };
}

// Rate types that use quantity=1 (per-visit / callout / flat)
const FIXED_QUANTITY_RATE_TYPES: Set<string> = new Set([
  'callout', 'per_visit', 'flat', 'per_notice', 'higher_duties_flat', 'oncall_flat',
]);

// ── SLA discount band lookup ─────────────────────────────────────────────────

interface SlaDiscountBand {
  over_by_minutes_min: number;
  over_by_minutes_max: number | null;
  discount_pct: number;
  service_type: string | null;
}

/**
 * Look up the SLA discount for a breached job.
 *
 * Given the breach amount (elapsed_minutes - target_minutes = overByMinutes),
 * find the matching band for the servicer org + optional service_type.
 * Service-type-specific bands take precedence over wildcard (NULL) bands.
 *
 * Returns the discount_pct (0-1), or null if no bands are configured.
 * A discount_pct of 1 means the line is non-billable.
 */
async function lookupSlaDiscount(
  supabase: SupabaseClient,
  organizationId: string,
  overByMinutes: number,
  serviceType: string | null,
): Promise<number | null> {
  // Fetch all bands for this org (both service-type-specific and wildcard)
  const { data: bands, error } = await supabase
    .from('sla_discount_bands')
    .select('over_by_minutes_min, over_by_minutes_max, discount_pct, service_type')
    .eq('organization_id', organizationId)
    .order('over_by_minutes_min', { ascending: true });

  if (error) {
    console.warn(`[invoicePipeline] Failed to fetch sla_discount_bands for org ${organizationId}:`, error.message);
    return null;
  }
  if (!bands || bands.length === 0) {
    return null; // No bands configured — caller falls back to no discount
  }

  const typedBands = bands as SlaDiscountBand[];

  // Try service-type-specific bands first, then wildcard (NULL service_type)
  const tiers: (string | null)[] = serviceType ? [serviceType, null] : [null];
  for (const tier of tiers) {
    const tierBands = typedBands.filter((b) => b.service_type === tier);
    for (const band of tierBands) {
      const minOk = overByMinutes >= band.over_by_minutes_min;
      const maxOk = band.over_by_minutes_max === null || overByMinutes < band.over_by_minutes_max;
      if (minOk && maxOk) {
        return Number(band.discount_pct);
      }
    }
  }

  // Breached but no band covers this overByMinutes value — no discount
  return 0;
}

// ── Sequential invoice number generation ─────────────────────────────────────

const MAX_INVOICE_NUMBER_RETRIES = 3;

/**
 * Generate a sequential, human-friendly invoice number: INV-<YYYY>-<NNNNNN>.
 * Sequential per servicer org per year. Uses MAX-based lookup + retry on
 * collision (ON CONFLICT is not needed because invoice_number has no unique
 * constraint — the retry guards against concurrent inserts).
 */
async function generateInvoiceNumber(
  supabase: SupabaseClient,
  servicerOrgId: string,
): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `INV-${year}-`;

  for (let attempt = 0; attempt < MAX_INVOICE_NUMBER_RETRIES; attempt++) {
    // Find the highest existing invoice_number for this org+year
    const { data: rows, error } = await supabase
      .from('invoices')
      .select('invoice_number')
      .eq('organization_id', servicerOrgId)
      .like('invoice_number', `${prefix}%`)
      .order('invoice_number', { ascending: false })
      .limit(1);

    let nextSeq = 1;
    if (!error && rows && rows.length > 0) {
      const lastNumber = rows[0].invoice_number as string;
      const seqPart = lastNumber.substring(prefix.length);
      const parsed = parseInt(seqPart, 10);
      if (!isNaN(parsed)) {
        nextSeq = parsed + 1;
      }
    }

    const candidate = `${prefix}${String(nextSeq).padStart(6, '0')}`;

    // Verify the candidate doesn't already exist (collision guard)
    const { count, error: checkErr } = await supabase
      .from('invoices')
      .select('id', { count: 'exact', head: true })
      .eq('invoice_number', candidate);

    if (checkErr) {
      console.warn(`[invoicePipeline] Error checking invoice number collision:`, checkErr.message);
      // Fall through to next attempt
      continue;
    }

    if ((count ?? 0) === 0) {
      return candidate;
    }

    // Collision — retry with fresh MAX lookup
    console.warn(`[invoicePipeline] Invoice number collision on ${candidate}, retrying (attempt ${attempt + 1})`);
  }

  // Exhausted retries — fall back to a timestamped number to avoid blocking
  const fallback = `${prefix}${Date.now()}`;
  console.warn(`[invoicePipeline] Exhausted invoice number retries, using fallback: ${fallback}`);
  return fallback;
}

// ── Day category helper ──────────────────────────────────────────────────────

function resolveDayCategory(date: Date): DayCategory {
  const day = date.getDay();
  if (day === 0 || day === 6) return 'weekend';
  const hour = date.getHours();
  if (hour < 6 || hour >= 22) return 'night';
  return 'weekday';
  // NOTE: public_holiday detection requires a holiday calendar; weekday is the
  // safe default. The rate engine will still match public_holiday rules if the
  // caller overrides dayCategory in the future.
}

// ── PART 2: Travel distance computation ──────────────────────────────────────

interface TravelDistanceResult {
  distanceKm: number | null;
  reason: string | null; // null = computed OK; non-null = why distance is NULL
}

/**
 * Compute the travel distance from the officer's origin to the job site.
 *
 * Officer origin is derived from (in priority order):
 *   1. dispatch_resources.location_id -> client_sites.center_point (the
 *      resource's home base / branch site)
 *   2. Falls back to NULL with a loud reason.
 *
 * Site destination is client_sites.center_point (prefer) or gps_lat/gps_lng.
 *
 * Distance is ST_Distance on geography (metres) converted to km.
 * Uses a Supabase RPC call to avoid pulling PostGIS into the JS bundle.
 *
 * Returns { distanceKm, reason } -- distanceKm is null when underivable,
 * with reason explaining why. NEVER returns silent 0.
 */
async function computeTravelDistanceKm(
  supabase: SupabaseClient,
  job: { id: string; client_site_id: string | null; dispatch_resource_id: string | null },
): Promise<TravelDistanceResult> {
  // Guard: need a site to measure TO
  if (!job.client_site_id) {
    return { distanceKm: null, reason: 'no client_site_id on job' };
  }

  // Fetch destination site geometry
  const { data: destSite, error: destErr } = await supabase
    .from('client_sites')
    .select('id, center_point, gps_lat, gps_lng')
    .eq('id', job.client_site_id)
    .single();
  if (destErr || !destSite) {
    return { distanceKm: null, reason: `failed to fetch destination site ${job.client_site_id}` };
  }
  const destHasGeom = destSite.center_point != null;
  const destHasGps = destSite.gps_lat != null && destSite.gps_lng != null;
  if (!destHasGeom && !destHasGps) {
    return { distanceKm: null, reason: `destination site ${job.client_site_id} has no geometry (no center_point, no gps_lat/lng)` };
  }

  // Derive officer origin from dispatch_resource -> location_id -> client_sites
  if (!job.dispatch_resource_id) {
    return { distanceKm: null, reason: 'no dispatch_resource_id on job -- cannot derive officer origin' };
  }

  const { data: resource, error: resErr } = await supabase
    .from('dispatch_resources')
    .select('id, location_id')
    .eq('id', job.dispatch_resource_id)
    .single();
  if (resErr || !resource) {
    return { distanceKm: null, reason: `failed to fetch dispatch_resource ${job.dispatch_resource_id}` };
  }
  if (!resource.location_id) {
    return { distanceKm: null, reason: `dispatch_resource ${job.dispatch_resource_id} has no location_id (no home base)` };
  }

  // The resource location_id references the locations table (0002/0145).
  // We need to find a client_site linked to this location for geometry.
  // locations table has gps_lat/gps_lng (0002) and client_site_id (0002).
  const { data: originLoc, error: locErr } = await supabase
    .from('locations')
    .select('id, gps_lat, gps_lng, client_site_id')
    .eq('id', resource.location_id)
    .single();
  if (locErr || !originLoc) {
    return { distanceKm: null, reason: `failed to fetch origin location ${resource.location_id}` };
  }

  // Try to get origin geometry: from linked client_site center_point, else location gps
  let originLat: number | null = null;
  let originLng: number | null = null;

  if (originLoc.client_site_id) {
    const { data: originSite } = await supabase
      .from('client_sites')
      .select('center_point, gps_lat, gps_lng')
      .eq('id', originLoc.client_site_id)
      .single();
    if (originSite) {
      if (originSite.center_point != null) {
        // center_point is a PostGIS geometry; we need to extract lat/lng via SQL
        // Use the location's gps as fallback since we can't parse WKB in JS
        originLat = originSite.gps_lat;
        originLng = originSite.gps_lng;
      } else {
        originLat = originSite.gps_lat;
        originLng = originSite.gps_lng;
      }
    }
  }

  // Fallback to location's own gps
  if (originLat == null || originLng == null) {
    originLat = originLoc.gps_lat;
    originLng = originLoc.gps_lng;
  }

  if (originLat == null || originLng == null) {
    return { distanceKm: null, reason: `officer origin (location ${resource.location_id}) has no usable coordinates` };
  }

  // Destination coordinates
  let destLat: number | null = destSite.gps_lat;
  let destLng: number | null = destSite.gps_lng;
  // If center_point exists but gps_lat/lng are null, we cannot extract from
  // the WKB in JS. The gps_lat/lng columns are the reliable fallback (0008).
  if (destLat == null || destLng == null) {
    return { distanceKm: null, reason: `destination site ${job.client_site_id} has center_point but no gps_lat/lng for distance calc` };
  }

  // Compute distance using PostGIS via raw SQL RPC
  // ST_Distance on geography returns metres
  const { data: distResult, error: distErr } = await supabase.rpc(
    'compute_point_distance_km',
    {
      lat1: originLat,
      lng1: originLng,
      lat2: destLat,
      lng2: destLng,
    },
  );

  if (distErr || distResult == null) {
    // Fallback: Haversine approximation in JS (good enough for NZ distances)
    const km = haversineKm(originLat, originLng, destLat, destLng);
    console.info(
      `[invoicePipeline] PostGIS RPC unavailable for distance calc (${distErr?.message ?? 'null result'}), ` +
      `using Haversine fallback: ${km.toFixed(3)} km`,
    );
    return { distanceKm: round2(km), reason: null };
  }

  return { distanceKm: round2(Number(distResult)), reason: null };
}

/** Haversine distance in km (fallback when PostGIS RPC is unavailable). */
function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371; // Earth radius km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// ── Zone resolution helper (point-in-geofence, with site-based fallback) ─────

/**
 * Resolve the zone for a dispatch job via TRUE POINT-IN-GEOFENCE resolution.
 *
 * Strategy (point-first, safe fallback):
 *   1. Determine the job's GPS point:
 *      - Prefer the site's gps_lat/gps_lng (contracted job at a known site).
 *      - Fall back to the job's insert_gps_lat/insert_gps_lng (ad-hoc insertion point).
 *   2. If a point is available, call the existing `resolve_context` RPC
 *      (migration 0090/0290) which does ST_Contains over location_zones.boundary
 *      with child-zone priority (parent_zone_id IS NOT NULL DESC, most-specific
 *      zone wins). Returns `matched_zone_id`.
 *   3. If no point is available OR the point matches no bounded zone, fall back
 *      to the legacy site_id-based lookup (location_zones.site_id, children first,
 *      LIMIT 1) so we never crash or silently return null when a zone exists.
 *
 * resolve_context signature (0290):
 *   resolve_context(p_lat float8, p_lng float8, p_org_id uuid,
 *                   p_module_key text DEFAULT NULL, p_at timestamptz DEFAULT now())
 *   returns table(... matched_zone_id uuid ...)
 *
 * @returns zone_id (string) or null — same shape as the old resolveZoneForSite.
 */
async function resolveZoneForJob(
  supabase: SupabaseClient,
  clientSiteId: string | null,
  organizationId: string,
  insertGpsLat?: number | null,
  insertGpsLng?: number | null,
): Promise<string | null> {
  // ── Step 1: determine the job's GPS point ──
  let lat: number | null = null;
  let lng: number | null = null;

  // Prefer the site's canonical GPS (contracted job)
  if (clientSiteId) {
    const { data: site } = await supabase
      .from('client_sites')
      .select('gps_lat, gps_lng')
      .eq('id', clientSiteId)
      .single();
    if (site?.gps_lat != null && site?.gps_lng != null) {
      lat = site.gps_lat;
      lng = site.gps_lng;
    }
  }

  // Fall back to the job's ad-hoc insertion point
  if (lat == null || lng == null) {
    if (insertGpsLat != null && insertGpsLng != null) {
      lat = insertGpsLat;
      lng = insertGpsLng;
    }
  }

  // ── Step 2: point-in-geofence via resolve_context RPC ──
  if (lat != null && lng != null) {
    try {
      const { data: ctx, error: rpcErr } = await supabase.rpc('resolve_context', {
        p_lat: lat,
        p_lng: lng,
        p_org_id: organizationId,
      });
      // resolve_context returns a single-row result set
      const row = Array.isArray(ctx) ? ctx[0] : ctx;
      if (!rpcErr && row?.matched_zone_id) {
        return row.matched_zone_id as string;
      }
      // Point matched no zone — fall through to site-based fallback
    } catch {
      // RPC not available (e.g. function not deployed yet) — fall through
      console.info('[resolveZoneForJob] resolve_context RPC unavailable, falling back to site-based lookup');
    }
  }

  // ── Step 3: site-based fallback (legacy behaviour) ──
  if (!clientSiteId) return null;
  const { data, error } = await supabase
    .from('location_zones')
    .select('id')
    .eq('site_id', clientSiteId)
    .eq('organization_id', organizationId)
    .order('parent_zone_id', { ascending: false, nullsFirst: false }) // children first
    .limit(1);
  if (error || !data || data.length === 0) return null;
  return data[0].id;
}

// ── PART 1: Pay/cost capture ─────────────────────────────────────────────────

/**
 * Resolve and persist pay lines for the PERFORMER of a completed dispatch job.
 *
 * CRITICAL: pay fires INDEPENDENTLY of billing. It runs even when
 * service_agreement_id is NULL (self-request / own-staff-on-owned-site =
 * internal cost, no external invoice). This is the ratified 'payer and
 * performer resolve independently' rule.
 *
 * Non-throwing: logs warnings on failure, never surfaces errors to the
 * dispatcher (the job is already completed).
 */
async function createPayLinesForJob(
  supabase: SupabaseClient,
  jobId: string,
): Promise<void> {
  try {
    // (a) Fetch the job with fields needed for pay resolution
    const { data: job, error: jobErr } = await supabase
      .from('dispatch_jobs')
      .select('id, organization_id, service_agreement_id, client_site_id, job_type, sla_minutes, completed_at, dispatch_resource_id, insert_gps_lat, insert_gps_lng')
      .eq('id', jobId)
      .single();
    if (jobErr || !job) {
      console.warn(`[payPipeline] Failed to fetch job ${jobId}:`, jobErr?.message);
      return;
    }

    const servicerOrgId = job.organization_id;

    // (b) Resolve the performing officer.
    // dispatch_jobs has no direct officer column (jobs dispatch to a resource /
    // callsign; the roster resolves the officer) -- resolve via the resource's
    // assigned_officer_id.
    let officerUserId: string | null = null;
    if (job.dispatch_resource_id) {
      const { data: resource } = await supabase
        .from('dispatch_resources')
        .select('assigned_officer_id')
        .eq('id', job.dispatch_resource_id)
        .single();
      if (resource?.assigned_officer_id) {
        officerUserId = resource.assigned_officer_id;
      }
    }

    // (c) Resolve officer role_code from staff_branch_authorisations
    let roleCode: string | undefined;
    if (officerUserId) {
      const { data: sba } = await supabase
        .from('staff_branch_authorisations')
        .select('role_at_branch')
        .eq('user_id', officerUserId)
        .eq('branch_org_id', servicerOrgId)
        .eq('status', 'active')
        .limit(1)
        .maybeSingle();
      if (sba?.role_at_branch) {
        // Map role_at_branch to reference_codes role_code convention
        // role_at_branch values: officer, branch_manager, etc.
        // role_code values: CAS, PFT, PPT, PTL, FSO, OPS, NSC, TRAIN, OVH
        // The staff_profiles employment_type is a better proxy for pay tier
        const { data: staffProfile } = await supabase
          .from('staff_profiles')
          .select('employment_type')
          .eq('user_id', officerUserId)
          .maybeSingle();
        if (staffProfile?.employment_type) {
          // Map employment_type to role_code
          const empToRole: Record<string, string> = {
            casual: 'CAS',
            permanent: 'PFT',
            part_time: 'PPT',
            contractor: 'CAS',
            volunteer: 'CAS',
          };
          roleCode = empToRole[staffProfile.employment_type] ?? undefined;
        }
      }
    }

    // (d) Resolve site context for region_code and service_type
    let regionCode: string | undefined;
    let serviceType: string | undefined;
    if (job.client_site_id) {
      const { data: site } = await supabase
        .from('client_sites')
        .select('id, name')
        .eq('id', job.client_site_id)
        .single();
      // Region/service_type come from the dispatch_resource or the job itself
      // The dispatch_resource.service_type is the best source
      if (job.dispatch_resource_id) {
        const { data: res } = await supabase
          .from('dispatch_resources')
          .select('service_type')
          .eq('id', job.dispatch_resource_id)
          .single();
        if (res?.service_type) serviceType = res.service_type;
      }
    }

    // (e) Fetch the sla_clock for hours worked
    const { data: slaClock } = await supabase
      .from('sla_clocks')
      .select('id, status, target_minutes, started_at, arrived_at, elapsed_minutes')
      .eq('dispatch_job_id', jobId)
      .maybeSingle();

    // (f) Compute travel distance (Part 2)
    const travel = await computeTravelDistanceKm(supabase, {
      id: job.id,
      client_site_id: job.client_site_id,
      dispatch_resource_id: job.dispatch_resource_id,
    });
    if (travel.reason) {
      console.info(`[payPipeline] Travel distance NULL for job ${jobId}: ${travel.reason}`);
    } else {
      console.info(`[payPipeline] Travel distance for job ${jobId}: ${travel.distanceKm} km`);
    }

    // (g) Fetch pay rate_rules for the servicer org
    const { data: rateRows, error: rateErr } = await supabase
      .from('rate_rules')
      .select('*')
      .eq('organization_id', servicerOrgId)
      .eq('rule_kind', 'pay')
      .eq('active', true);
    if (rateErr) {
      console.warn(`[payPipeline] Failed to fetch pay rate_rules for org ${servicerOrgId}:`, rateErr.message);
      return;
    }
    if (!rateRows || rateRows.length === 0) {
      console.info(`[payPipeline] No active pay rate_rules for org ${servicerOrgId} -- pay lines not created for job ${jobId}`);
      return;
    }

    const rules: RateRule[] = rateRows.map((r: any) => toRateRule(r as RateRuleRow));
    const completedDate = job.completed_at
      ? new Date(job.completed_at)
      : new Date();
    const today = completedDate.toISOString().split('T')[0];
    const dayCategory = resolveDayCategory(completedDate);

    // (h) Resolve zone via point-in-geofence (resolve_context RPC), site-based fallback
    const zoneId = await resolveZoneForJob(supabase, job.client_site_id, servicerOrgId, job.insert_gps_lat, job.insert_gps_lng);

    // (i) Build RateContext for pay resolution
    const payCtx: RateContext = {
      date: today,
      roleCode,
      regionCode,
      serviceType,
      jobType: job.job_type ?? undefined,
      siteId: job.client_site_id ?? undefined,
      zoneId: zoneId ?? undefined,
      dayCategory,
      distanceKm: travel.distanceKm ?? undefined,
    };

    // (i) Resolve pay lines
    const payRules = resolvePayLines(rules, payCtx);
    if (payRules.length === 0) {
      console.info(`[payPipeline] No matching pay rules for job ${jobId} -- no pay lines created`);
      return;
    }

    // (j) Fetch org_rate_settings for multipliers and rounding
    const { data: orgSettings } = await supabase
      .from('org_rate_settings')
      .select('pay_policy, overtime_multiplier, double_multiplier, rounding')
      .eq('organization_id', servicerOrgId)
      .maybeSingle();

    const overtimeMultiplier = orgSettings?.overtime_multiplier ? Number(orgSettings.overtime_multiplier) : 1.5;
    const doubleMultiplier = orgSettings?.double_multiplier ? Number(orgSettings.double_multiplier) : 2.0;
    const rounding = orgSettings?.rounding ?? 'cent';

    // Determine multiplier based on day_category
    let multiplier = 1;
    if (dayCategory === 'public_holiday') {
      multiplier = doubleMultiplier;
    } else if (dayCategory === 'weekend' || dayCategory === 'night') {
      multiplier = overtimeMultiplier;
    }

    // (k) Calculate quantity (hours) from sla_clock or sla_minutes
    const onSiteMinutes = slaClock?.elapsed_minutes ?? job.sla_minutes ?? 60;
    const hoursWorked = round2(onSiteMinutes / 60);

    // (l) Apply rates and build insert rows
    const insertRows: any[] = [];
    for (const rule of payRules) {
      let quantity: number;
      if (FIXED_QUANTITY_RATE_TYPES.has(rule.rateType)) {
        quantity = 1;
      } else if (rule.rateType === 'per_km') {
        quantity = travel.distanceKm ?? 0;
        if (quantity <= 0) continue; // No distance = no per_km line
      } else {
        quantity = hoursWorked > 0 ? hoursWorked : 1;
      }

      const rated = applyRate(rule, quantity);
      let lineTotal = round2(rated.amount * multiplier);

      // Apply rounding
      if (rounding === 'dollar') {
        lineTotal = Math.round(lineTotal);
      }
      // 'cent' is already round2; 'none' we leave as-is (round2 is safe)

      const payCode = rule.payCode ?? null;

      insertRows.push({
        organization_id: servicerOrgId,
        source_dispatch_id: jobId,
        officer_user_id: officerUserId,
        rate_rule_id: rule.id,
        pay_code: payCode,
        rate_type: rule.rateType,
        description: rule.name,
        quantity,
        unit_rate: rule.amount,
        multiplier,
        line_total: lineTotal,
        distance_km: travel.distanceKm,
        distance_reason: travel.reason,
        role_code: roleCode ?? null,
        region_code: regionCode ?? null,
        service_type: serviceType ?? null,
        day_category: dayCategory,
      });
    }

    if (insertRows.length === 0) {
      console.info(`[payPipeline] All pay rules filtered out for job ${jobId} (e.g. per_km with no distance)`);
      return;
    }

    // (m) Upsert pay lines (idempotent via partial unique indexes)
    // Insert with ON CONFLICT DO NOTHING -- the partial unique indexes on
    // (organization_id, source_dispatch_id, pay_code) handle idempotency.
    const { error: insertErr } = await supabase
      .from('dispatch_job_pay_lines')
      .upsert(insertRows, { onConflict: 'organization_id,source_dispatch_id,pay_code', ignoreDuplicates: true });
    if (insertErr) {
      // Fallback: try individual inserts to handle the base (null pay_code) case
      console.warn(`[payPipeline] Bulk upsert failed (${insertErr.message}), trying individual inserts`);
      for (const row of insertRows) {
        const { error: singleErr } = await supabase
          .from('dispatch_job_pay_lines')
          .insert(row);
        if (singleErr) {
          // 23505 = unique_violation = already exists = idempotent success
          if (singleErr.code !== '23505') {
            console.warn(`[payPipeline] Failed to insert pay line (pay_code=${row.pay_code}) for job ${jobId}:`, singleErr.message);
          }
        }
      }
    }

    const totalPay = round2(insertRows.reduce((s: number, r: any) => s + r.line_total, 0));
    console.info(
      `[payPipeline] ${insertRows.length} pay line(s) created for job ${jobId}: ` +
      `total=$${totalPay}, officer=${officerUserId ?? 'unknown'}, ` +
      `distance=${travel.distanceKm != null ? travel.distanceKm + 'km' : 'NULL (' + travel.reason + ')'}`,
    );
  } catch (err: any) {
    console.warn(`[payPipeline] Unexpected error creating pay lines for job ${jobId}:`, err?.message ?? err);
  }
}

// ── PART 3: Layer-2 on-charge creation ───────────────────────────────────────

/**
 * Where billing_direction='on_charge' on the service agreement modules,
 * create the provider->client on-charge quote_line so the monitoring-company
 * case flows end to end.
 *
 * Uses the existing quotes/quote_lines schema (migration 0255). Creates or
 * reuses a draft quote for the provider->client pair, then adds a line per
 * on-charge module. Idempotent via quote_lines.source_dispatch_id (0290).
 *
 * Non-throwing: logs warnings on failure.
 */
async function createOnChargeForJob(
  supabase: SupabaseClient,
  jobId: string,
): Promise<void> {
  try {
    // (a) Fetch the job
    const { data: job, error: jobErr } = await supabase
      .from('dispatch_jobs')
      .select('id, organization_id, service_agreement_id, client_site_id, job_type, completed_at, insert_gps_lat, insert_gps_lng')
      .eq('id', jobId)
      .single();
    if (jobErr || !job) {
      console.warn(`[onChargePipeline] Failed to fetch job ${jobId}:`, jobErr?.message);
      return;
    }

    // On-charge requires a service_agreement_id (it's a provider->client flow)
    if (!job.service_agreement_id) {
      return; // No agreement = no on-charge (internal job)
    }

    const servicerOrgId = job.organization_id;
    const agreementId = job.service_agreement_id;

    // (b) Check for on-charge modules on this agreement
    const { data: onChargeModules, error: modErr } = await supabase
      .from('service_agreement_modules')
      .select('id, module_key, billing_direction')
      .eq('service_agreement_id', agreementId)
      .eq('billing_direction', 'on_charge');
    if (modErr) {
      console.warn(`[onChargePipeline] Failed to fetch on-charge modules for agreement ${agreementId}:`, modErr.message);
      return;
    }
    if (!onChargeModules || onChargeModules.length === 0) {
      return; // No on-charge modules -- nothing to do
    }

    // (c) Fetch the service_agreement for client_organization_id
    const { data: agreement, error: saErr } = await supabase
      .from('service_agreements')
      .select('id, client_organization_id, provider_organization_id')
      .eq('id', agreementId)
      .single();
    if (saErr || !agreement) {
      console.warn(`[onChargePipeline] Failed to fetch agreement ${agreementId}:`, saErr?.message);
      return;
    }
    const clientOrgId = agreement.client_organization_id;

    // (d) Resolve the billing rate for the on-charge (what the provider charges)
    const { data: billingRateRows } = await supabase
      .from('rate_rules')
      .select('*')
      .eq('organization_id', servicerOrgId)
      .eq('rule_kind', 'billing')
      .eq('active', true);

    let unitCharge = 0;
    let chargeDescription = '';
    if (billingRateRows && billingRateRows.length > 0) {
      const billingRules: RateRule[] = billingRateRows.map((r: any) => toRateRule(r as RateRuleRow));
      const today = new Date().toISOString().split('T')[0];
      // Resolve zone via point-in-geofence (resolve_context RPC), site-based fallback
      const onChargeZoneId = await resolveZoneForJob(supabase, job.client_site_id, servicerOrgId, job.insert_gps_lat, job.insert_gps_lng);
      const resolved = resolveRate(billingRules, 'billing', {
        clientOrgId,
        jobType: job.job_type ?? undefined,
        siteId: job.client_site_id ?? undefined,
        zoneId: onChargeZoneId ?? undefined,
        date: today,
      });
      if (resolved) {
        unitCharge = resolved.amount;
        chargeDescription = resolved.name;
      }
    }

    // (e) Resolve the cost (what the provider pays the officer) from pay lines
    const { data: payLines } = await supabase
      .from('dispatch_job_pay_lines')
      .select('line_total')
      .eq('source_dispatch_id', jobId);
    const unitCost = payLines
      ? round2(payLines.reduce((s: number, l: any) => s + Number(l.line_total), 0))
      : 0;

    // (f) Find or create a draft quote for this provider->client pair
    const { data: existingQuote } = await supabase
      .from('quotes')
      .select('id')
      .eq('provider_org_id', servicerOrgId)
      .eq('client_org_id', clientOrgId)
      .eq('status', 'draft')
      .limit(1)
      .maybeSingle();

    let quoteId: string;
    if (existingQuote) {
      quoteId = existingQuote.id;
    } else {
      // Fetch org_rate_settings for quote defaults
      const { data: orgSettings } = await supabase
        .from('org_rate_settings')
        .select('target_margin_pct, gst_rate, currency')
        .eq('organization_id', servicerOrgId)
        .maybeSingle();

      const { data: newQuote, error: quoteErr } = await supabase
        .from('quotes')
        .insert({
          provider_org_id: servicerOrgId,
          client_org_id: clientOrgId,
          title: 'On-charge for dispatch services',
          status: 'draft',
          currency: orgSettings?.currency ?? 'NZD',
          target_margin_pct: orgSettings?.target_margin_pct ? Number(orgSettings.target_margin_pct) : 0,
          gst_rate: orgSettings?.gst_rate ? Number(orgSettings.gst_rate) : 0.15,
          platform_fee_treatment: 'passthrough',
          total_cost: 0,
          subtotal_charge: 0,
          discount_amount: 0,
          gst_amount: 0,
          total_charge: 0,
        })
        .select('id')
        .single();
      if (quoteErr || !newQuote) {
        console.warn(`[onChargePipeline] Failed to create on-charge quote for job ${jobId}:`, quoteErr?.message);
        return;
      }
      quoteId = newQuote.id;
    }

    // (g) Determine next line_order
    const { count: existingLineCount } = await supabase
      .from('quote_lines')
      .select('id', { count: 'exact', head: true })
      .eq('quote_id', quoteId);
    const lineOrder = (existingLineCount ?? 0) + 1;

    // (h) Build site name for description
    let siteName = 'Unknown site';
    if (job.client_site_id) {
      const { data: site } = await supabase
        .from('client_sites')
        .select('name')
        .eq('id', job.client_site_id)
        .single();
      if (site) siteName = site.name;
    }
    const jobTypeLabel = (job.job_type ?? 'dispatch').replace(/_/g, ' ');
    const moduleKeys = onChargeModules.map((m: any) => m.module_key).join(', ');
    const description = chargeDescription
      ? `On-charge: ${chargeDescription} -- ${jobTypeLabel} at ${siteName} (${moduleKeys})`
      : `On-charge: ${jobTypeLabel} at ${siteName} (${moduleKeys})`;

    // (i) Insert on-charge quote_line (idempotent via source_dispatch_id)
    const { error: lineErr } = await supabase
      .from('quote_lines')
      .insert({
        quote_id: quoteId,
        kind: 'custom',
        description,
        quantity: 1,
        unit_cost: unitCost,
        unit_charge: unitCharge,
        module_key: onChargeModules[0]?.module_key ?? null,
        site_id: job.client_site_id ?? null,
        line_order: lineOrder,
        source_dispatch_id: jobId,
      });
    if (lineErr) {
      // 23505 = unique_violation = already exists = idempotent success
      if (lineErr.code === '23505') {
        console.info(`[onChargePipeline] On-charge line already exists for job ${jobId} (idempotent)`);
        return;
      }
      console.warn(`[onChargePipeline] Failed to insert on-charge quote_line for job ${jobId}:`, lineErr.message);
      return;
    }

    console.info(
      `[onChargePipeline] On-charge quote_line created for job ${jobId}: ` +
      `quote=${quoteId}, cost=$${unitCost}, charge=$${unitCharge}, modules=${moduleKeys}`,
    );
  } catch (err: any) {
    console.warn(`[onChargePipeline] Unexpected error creating on-charge for job ${jobId}:`, err?.message ?? err);
  }
}

// ── Completion pipeline orchestrator ─────────────────────────────────────────

/**
 * Run the COMPLETE financial completion pipeline for a dispatch job.
 *
 * Orchestrates three independent, non-throwing steps:
 *   1. PAY/COST: resolve + persist pay lines for the performer
 *   2. BILLING: create invoice line item (existing behaviour, unchanged)
 *   3. ON-CHARGE: create Layer-2 on-charge quote_line where applicable
 *
 * Pay fires INDEPENDENTLY of billing -- it runs even when
 * service_agreement_id is NULL. Each step is non-throwing so a failure
 * in one does not block the others.
 */
export async function runCompletionPipeline(
  supabase: SupabaseClient,
  jobId: string,
): Promise<void> {
  // Step 1: Pay/cost capture (runs independently of billing)
  await createPayLinesForJob(supabase, jobId);

  // Step 2: Billing (existing behaviour, unchanged)
  await createInvoiceLineForJob(supabase, jobId);

  // Step 3: Layer-2 on-charge (runs after billing so pay lines exist for cost)
  await createOnChargeForJob(supabase, jobId);
}

/**
 * Create an invoice line item for a completed dispatch job.
 *
 * Non-throwing: all errors are logged as warnings so that invoice creation
 * failure never confuses the dispatcher (the job is already completed).
 */
export async function createInvoiceLineForJob(
  supabase: SupabaseClient,
  jobId: string,
): Promise<void> {
  try {
    // (a) Fetch the job
    const { data: job, error: jobErr } = await supabase
      .from('dispatch_jobs')
      .select('id, organization_id, service_agreement_id, sla_minutes, client_site_id, job_type, completed_at, insert_gps_lat, insert_gps_lng')
      .eq('id', jobId)
      .single();
    if (jobErr || !job) {
      console.warn(`[invoicePipeline] Failed to fetch job ${jobId}:`, jobErr?.message);
      return;
    }

    // (b) Guard — service_agreement_id required (Phase C populates this)
    if (!job.service_agreement_id) {
      console.warn(`[invoicePipeline] Job ${jobId} has no service_agreement_id — cannot create invoice line`);
      return;
    }

    const servicerOrgId = job.organization_id;
    const agreementId = job.service_agreement_id;

    // (c) Fetch the service_agreement → client_organization_id (REQUESTER/payer)
    const { data: agreement, error: saErr } = await supabase
      .from('service_agreements')
      .select('id, client_organization_id, provider_organization_id')
      .eq('id', agreementId)
      .single();
    if (saErr || !agreement) {
      console.warn(`[invoicePipeline] Failed to fetch agreement ${agreementId}:`, saErr?.message);
      return;
    }
    const requesterOrgId = agreement.client_organization_id;

    // (d) Fetch the sla_clock for this job
    const { data: slaClock } = await supabase
      .from('sla_clocks')
      .select('id, status, target_minutes, started_at, arrived_at, elapsed_minutes')
      .eq('dispatch_job_id', jobId)
      .maybeSingle();

    // (e) Fetch rate_rules for the SERVICER and resolve
    const { data: rateRows, error: rateErr } = await supabase
      .from('rate_rules')
      .select('*')
      .eq('organization_id', servicerOrgId)
      .eq('rule_kind', 'billing')
      .eq('active', true);
    if (rateErr) {
      console.warn(`[invoicePipeline] Failed to fetch rate_rules for org ${servicerOrgId}:`, rateErr.message);
      return;
    }
    if (!rateRows || rateRows.length === 0) {
      console.warn(`[invoicePipeline] No active billing rate_rules for org ${servicerOrgId} — cannot price job ${jobId}`);
      return;
    }

    const rules: RateRule[] = rateRows.map((r: any) => toRateRule(r as RateRuleRow));
    const today = new Date().toISOString().split('T')[0];

    // Resolve zone via point-in-geofence (resolve_context RPC), site-based fallback
    const billingZoneId = await resolveZoneForJob(supabase, job.client_site_id, servicerOrgId, job.insert_gps_lat, job.insert_gps_lng);

    const resolvedRule = resolveRate(rules, 'billing', {
      clientOrgId: requesterOrgId,
      jobType: job.job_type,
      siteId: job.client_site_id ?? undefined,
      zoneId: billingZoneId ?? undefined,
      date: today,
    });
    if (!resolvedRule) {
      console.warn(`[invoicePipeline] No matching billing rate for job ${jobId} (jobType=${job.job_type}, requester=${requesterOrgId}) — unrateable`);
      return;
    }

    // (f) Calculate quantity
    let quantity = 1;
    if (!FIXED_QUANTITY_RATE_TYPES.has(resolvedRule.rateType)) {
      const onSiteMinutes = slaClock?.elapsed_minutes ?? job.sla_minutes ?? 60;
      quantity = round2(onSiteMinutes / 60);
      if (quantity <= 0) quantity = 1;
    }

    // (g) Apply SLA-scaled discount from sla_discount_bands
    let discount = 0;
    if (slaClock?.status === 'breached' && slaClock.elapsed_minutes != null && slaClock.target_minutes != null) {
      const overByMinutes = slaClock.elapsed_minutes - slaClock.target_minutes;
      if (overByMinutes > 0) {
        const serviceType = resolvedRule.serviceType ?? job.job_type ?? null;
        const bandDiscount = await lookupSlaDiscount(supabase, servicerOrgId, overByMinutes, serviceType);
        if (bandDiscount === null) {
          // No bands configured for this org — fall back to NO discount (not the old 10%)
          console.info(
            `[invoicePipeline] No SLA discount bands configured for org ${servicerOrgId} — ` +
            `applying no discount for breached job ${jobId} (over by ${overByMinutes} min)`,
          );
          discount = 0;
        } else if (bandDiscount >= 1) {
          // 100% band = non-billable cutoff — skip line creation entirely
          console.info(
            `[invoicePipeline] Job ${jobId} is NON-BILLABLE: SLA breach of ${overByMinutes} min ` +
            `falls in 100% discount band for org ${servicerOrgId} — skipping invoice line`,
          );
          return;
        } else {
          discount = bandDiscount;
        }
      }
    }

    // (h) Calculate line_total
    const rated = applyRate(resolvedRule, quantity);
    const lineTotal = round2(rated.amount * (1 - discount));
    const unitPrice = resolvedRule.amount;

    // (i) Find or create a draft invoice for this service_agreement
    const { data: existingInvoice } = await supabase
      .from('invoices')
      .select('id')
      .eq('service_agreement_id', agreementId)
      .eq('status', 'draft')
      .limit(1)
      .maybeSingle();

    let invoiceId: string;
    if (existingInvoice) {
      invoiceId = existingInvoice.id;
    } else {
      const dueDate = new Date(Date.now() + 20 * 86400000).toISOString().split('T')[0];
      const invoiceNumber = await generateInvoiceNumber(supabase, servicerOrgId);
      const { data: newInvoice, error: invErr } = await supabase
        .from('invoices')
        .insert({
          organization_id: servicerOrgId,
          client_organization_id: requesterOrgId,
          service_agreement_id: agreementId,
          invoice_number: invoiceNumber,
          invoice_date: today,
          due_date: dueDate,
          status: 'draft',
          subtotal: 0,
          gst_amount: 0,
          total_amount: 0,
          currency: 'NZD',
          site_id: job.client_site_id ?? null,
        })
        .select('id')
        .single();
      if (invErr || !newInvoice) {
        console.warn(`[invoicePipeline] Failed to create invoice for agreement ${agreementId}:`, invErr?.message);
        return;
      }
      invoiceId = newInvoice.id;
    }

    // Determine next line_number
    const { count: existingLineCount } = await supabase
      .from('invoice_line_items')
      .select('id', { count: 'exact', head: true })
      .eq('invoice_id', invoiceId);
    const lineNumber = (existingLineCount ?? 0) + 1;

    // Build description
    let siteName = 'Unknown site';
    if (job.client_site_id) {
      const { data: site } = await supabase
        .from('client_sites').select('name').eq('id', job.client_site_id).single();
      if (site) siteName = site.name;
    }
    const jobTypeLabel = job.job_type.replace(/_/g, ' ');
    let description = `${jobTypeLabel} at ${siteName}`;
    if (discount > 0) description += ` (SLA breach: ${Math.round(discount * 100)}% discount applied)`;

    // (j) INSERT invoice_line_items
    const { error: lineErr } = await supabase
      .from('invoice_line_items')
      .insert({
        invoice_id: invoiceId,
        organization_id: servicerOrgId,
        source_dispatch_id: jobId,
        line_number: lineNumber,
        description,
        quantity,
        unit_price: unitPrice,
        line_total: lineTotal,
      });
    if (lineErr) {
      console.warn(`[invoicePipeline] Failed to insert invoice_line_item for job ${jobId}:`, lineErr.message);
      return;
    }
    console.info(`[invoicePipeline] Invoice line created for job ${jobId}: ${description} — qty=${quantity}, unit=${unitPrice}, total=${lineTotal}`);

    // (k) Layer-2 on-charge — now handled by createOnChargeForJob() in the
    // completion pipeline (runCompletionPipeline). This log is retained for
    // backward compatibility when createInvoiceLineForJob is called directly.
    const { data: onChargeModules } = await supabase
      .from('service_agreement_modules')
      .select('id, module_key, billing_direction')
      .eq('service_agreement_id', agreementId)
      .eq('billing_direction', 'on_charge');
    if (onChargeModules && onChargeModules.length > 0) {
      const moduleKeys = onChargeModules.map((m: any) => m.module_key).join(', ');
      console.info(
        `[invoicePipeline] Layer-2 on-charge applicable for job ${jobId} ` +
        `(agreement ${agreementId}, modules: ${moduleKeys}) — ` +
        `on-charge quote_line created by runCompletionPipeline`,
      );
    }
  } catch (err: any) {
    console.warn(`[invoicePipeline] Unexpected error creating invoice line for job ${jobId}:`, err?.message ?? err);
  }
}
