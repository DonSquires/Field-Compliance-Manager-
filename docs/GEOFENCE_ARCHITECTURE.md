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

## Verified Gap

`process-officer-scan` calls `resolve_context`, but it does not currently call
`is_zone_closed`. The administrative map inspector composes both results so the
gap is visible, but scan enforcement must not be described as closure-aware
until that production path consumes and acts on canonical closure evidence.

Two older helpers still reference obsolete `zone_closures.active_from` and
`active_to` columns. New work must use `status`, `effective_from`,
`effective_to`, and `is_zone_closed` rather than extending those legacy paths.