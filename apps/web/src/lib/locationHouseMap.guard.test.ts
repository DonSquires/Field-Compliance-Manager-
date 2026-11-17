/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src/components/LocationHouseMap.tsx'), 'utf8');

describe('location house map', () => {
  it('renders canonical site and zone facets as separate map layers', () => {
    expect(source).toContain('Site: ${site.name}');
    expect(source).toContain('Zone: ${zone.name}');
    expect(source).toContain('L.geoJSON');
  });

  it('uses the server-side LINZ proxy for address and boundary lookup', () => {
    expect(source.match(/functions\.invoke\('linz-lookup'/g)).toHaveLength(2);
    expect(source).toContain("action: 'address_autocomplete'");
    expect(source).toContain("action: 'boundary_for_point_escalating'");
  });

  it('keeps LINZ preview read-only and does not claim verification', () => {
    expect(source).toContain('A LINZ preview changes nothing until it is saved and confirmed.');
    expect(source).not.toContain(".from('");
    expect(source).not.toContain('.insert(');
    expect(source).not.toContain('.update(');
  });

  it('lets a person outline the place by hand and saves it through the governed proposal path', () => {
    expect(source).toContain("setDrawPoints((points) => [...points, [Number(latlng.lng.toFixed(7)), Number(latlng.lat.toFixed(7))]])");
    expect(source).toContain("'user_drawn'");
    expect(source).toContain("supabase.rpc('propose_boundary'");
    expect(source).toContain("supabase.rpc('accept_boundary_proposal'");
    expect(source).toContain('Draw the boundary');
    expect(source).toContain('Undo corner');
  });

  it('sets the geofence itself on a place with no boundary, and only on an exact LINZ match', () => {
    expect(source).toContain("preview?.match.startsWith('Exact')");
    expect(source).toContain('saveLinzBoundary(preview, false)');
    expect(source).toContain('if (facet?.boundary || autoResolvedRef.current === editableEntity.id) return;');
  });

  it('never auto-saves the house parcel onto a work area, which is usually only part of the place', () => {
    expect(source).toContain("if (!editableEntity || seedBoundary || editableEntity.type !== 'client_site') return;");
  });

  it('retires the LINZ preview once any boundary is saved, so a second button cannot overwrite a drawn shape', () => {
    const drawn = source.slice(source.indexOf('const saveDrawnBoundary'), source.indexOf('const confirmExistingBoundary'));
    expect(drawn).toContain('setDrawPoints([]);');
    expect(drawn).toContain('setLinzPreview(null);');
    const linz = source.slice(source.indexOf('const saveLinzBoundary'), source.indexOf('const autoResolvedRef'));
    expect(linz).toContain('setLinzPreview(null);');
    expect(source).toContain('Replace with this ${');
    expect(source).toContain('Use this ${');
  });

  it('names every Site or work area still needing review and lets the person jump to it', () => {
    expect(source).toContain('house-map-review-list');
    expect(source).toContain("'no boundary yet'");
    expect(source).toContain('onSelectFacet({ type, id: facet.id })');
  });

  it('counts each layer and keeps one review gate instead of calling work areas place boundaries', () => {
    expect(source).toContain('placeLayerGates(sites, zones, checkpointsProvided ? checkpoints : undefined)');
    expect(source).toContain('layerGates.review.label');
    expect(source).not.toContain('verified place boundar');
    expect(source).not.toContain('Site or work area{unresolvedFacets');
  });

  it('keeps checkpoints visible at any zoom and tells parent areas from their parts', () => {
    expect(source).toContain('L.circleMarker([checkpoint.gps_lat, checkpoint.gps_lng]');
    expect(source).toContain('L.circle([checkpoint.gps_lat, checkpoint.gps_lng]');
    expect(source).toContain(' · part of ${parent.name}');
    // Every ancestor draws before its descendants, so a grandchild stays on top with its own tooltip.
    expect(source).toContain('orderZonesByParent(zones).map(({ zone }) => zone)');
    expect(source).not.toContain('Number(Boolean(a.parent_zone_id))');
    expect(source).toContain('house-map-legend');
    expect(source).toContain('<span className="house-map-legend-area" />Work area');
    expect(source).toContain('<span className="house-map-legend-part" />Part of an area');
    expect(source).toContain('<span className="house-map-legend-checkpoint" />Checkpoint');
  });

  it('lists advisory containment warnings in the review-list style without blocking anything', () => {
    expect(source).toContain('placeAdvisories(sites, zones, checkpoints)');
    expect(source).toContain('house-map-review-list is-advisory');
    expect(source).toContain('Advisory only. Nothing is blocked');
  });

  it('resolves selected points through the canonical geofence spine', () => {
    expect(source).toContain("supabase.rpc('resolve_operational_context_authorized'");
    expect(source).toContain("supabase.rpc('is_zone_closed'");
    expect(source).toContain('p_org_id: organizationId');
    expect(source).toContain('matched_zone_id');
    expect(source).toContain('effective_rules');
    expect(source).toContain('A LINZ preview changes nothing until it is saved and confirmed.');
    expect(source).toContain('Boundary shows where work applies');
  });
});