# Geofence Architecture

Verified 2026-08-31 against `supabase/schema.sql`, the modular public schema,
active Edge Functions, frontend call sites, and Atlas.

## Third Spine

Geofencing is the platform's map-truth spine, alongside organization and user
identity. A geofence is the real-world boundary of a place: geometry answers
**where the place begins and ends**. It does not itself define freedom-camping,
parking, patrol, closure, billing, or enforcement policy. Those downstream
rules answer **what applies within that boundary**.

This distinction is load-bearing. A place may exist by name and address while
remaining operationally unresolved. Until its geometry is present, valid, and
verified, the platform must not confidently use it to trigger place-specific
workflows.

## Canonical Place Model

- `locations` is the physical-place house and ownership anchor. It has no
  geometry of its own.
- `client_sites` is the addressed Site facet. Its boundary and center point
  support on-site determination.
- `location_zones` is the operational area facet. Its verified polygon,
  module key, active schedule, jurisdiction rules, and overrides determine
  which place-specific workflow applies at a GPS point.
- A Site and Zone are sibling facets linked through `location_id`. A Site link
  may be used as a compatibility route to the house, but it is not a second
  ownership model.

## Boundary Lifecycle

1. Resolve the place or address using the best available source.
2. Prefer authoritative geometry: LINZ for addressed parcels/buildings,
   council GIS for council-managed areas, DOC for conservation land, and other
   accountable agency sources for their domains.
3. Use Google only to find or narrow a point when necessary. A geocoded point is
   not authoritative legal boundary evidence.
4. If no authoritative polygon is available, retain an explicit provisional
   point-radius state rather than disguising it as authoritative geometry.
5. Save new or changed geometry as unverified.
6. Require human map verification before runtime resolution treats it as active.
7. Record every authored, reconciled, refreshed, and verified version in
   `geofence_boundary_history` with source, actor, method, reason, and time.

`compare_boundaries_hausdorff` provides a material-shape comparison for drift
review. A newly resolved shape must not silently replace materially different
existing evidence.

## Runtime Resolution

`resolve_context(lat, lng, organization, module, at)` is the canonical resolver.
It evaluates:

1. verified organization operating bounds;
2. verified governing jurisdiction and overlap evidence;
3. valid, verified Zone polygons active at the requested time;
4. Site on-site geometry/radius;
5. house ownership through `location_id`;
6. jurisdiction rules, Zone limits, and rule overrides.

Its result drives or informs officer scans, point context, module selection,
on-site evidence, compliance attribution, routes, dispatch, reporting, and
commercial readiness. LINZ preview geometry is discovery evidence only; it is
not used by this resolver until it has passed persistence and verification.

Closures are a downstream operational overlay, resolved by `is_zone_closed`.
They do not change where the Zone is. They change what may happen there.

## Officer Scan Evidence

`process-officer-scan` now calls `resolve_context` and, after every matched or
manually selected Zone, calls `is_zone_closed`. Resolution and closure lookup
errors fail closed. The capture-time result is persisted in `geofence_context`
on freedom-camping observations and parking chalk records, and returned to the
officer UI as an explicit warning.

Closure evidence does not silently rewrite a freedom-camping or parking verdict.
The boundary still answers where, the module rules derive their own verdict, and
the closure remains a separately visible operational overlay until a governed
module-specific closure policy defines a stronger action.

Manual Zone selection is not a bypass around spatial governance. The scan
requires the Zone to belong to the caller's organization, be active and
verified, match the requested module, and be active under `_geofence_active_at`
at capture time. The snapshot records that direct point-in-polygon resolution
was not evaluated when a Zone was selected manually.

Every scan requires either that governed manual Zone or a complete, finite,
in-range GPS coordinate pair. The server rejects missing or partial spatial
evidence before inference or persistence; it never records an unevaluated scan
as implicitly inside operating bounds.

## Point Context Access

`resolve-point-context` supports officer reports and other GPS anchoring flows.
Before using its service-role client, it binds the requested organization to the
caller's active profile: home organization, explicit authorized organization, or
grand-master scope. Cross-tenant organization IDs are rejected before PostGIS or
Site reads occur.

Canonical `resolve_context`, descendant-scope, agreement-scope, and nearby-Site
query failures return an unavailable response rather than being reclassified as
an ordinary spatial miss. Only a successful resolution with no verified Zone or
verified Site continues to LINZ-first, Google-fallback address resolution.

Standalone Sites without a Zone are resolved by the service-only
`resolve_verified_site_context` RPC. It considers only active, valid, verified
Site geometry inside the already-authorized client organization scope, prefers
polygon coverage, and uses the configured on-site radius only as a secondary
match. Raw centroid proximity is not map truth.

Two older helpers still reference obsolete `zone_closures.active_from` and
`active_to` columns. New work must use `status`, `effective_from`,
`effective_to`, and `is_zone_closed` rather than extending those legacy paths.