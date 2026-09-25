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
    expect(source).toContain('LINZ preview is not saved, verified, or used by runtime resolution.');
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

  it('resolves selected points through the canonical geofence spine', () => {
    expect(source).toContain("supabase.rpc('resolve_context_authorized'");
    expect(source).toContain("supabase.rpc('is_zone_closed'");
    expect(source).toContain('p_org_id: organizationId');
    expect(source).toContain('matched_zone_id');
    expect(source).toContain('effective_rules');
    expect(source).toContain('LINZ preview is not saved, verified, or used by runtime resolution.');
    expect(source).toContain('Geometry answers where');
  });
});