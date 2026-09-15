/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const page = readFileSync(resolve(process.cwd(), 'src/pages/SiteBoundaryReviewPage.tsx'), 'utf8');

describe('geofence workbench — every boundary is a proposal until a human accepts and verifies it', () => {
  it('reads the unified queue and history through governed RPCs, never the tables', () => {
    expect(page).toContain("supabase.rpc('get_geofence_review_queue'");
    expect(page).toContain("supabase.rpc('get_boundary_history'");
    expect(page).not.toContain("supabase.from('client_sites')");
    expect(page).not.toContain("supabase.from('location_zones')");
    expect(page).not.toContain("supabase.from('boundary_proposals')");
    expect(page).toContain('selected.boundary_geojson');
    expect(page).toContain('selected.open_proposal_geojson');
    expect(page).toContain('L.geoJSON');
  });

  it('stages every source rung as a proposal (Q6 ladder) and never writes geometry directly', () => {
    expect(page).toContain("supabase.rpc('propose_boundary'");
    expect(page).toContain("action: 'boundary_for_point_escalating'");
    expect(page).toContain("'linz_building' : 'linz_parcel'");
    expect(page).toContain("'google_point_radius'");
    expect(page).toContain("'user_drawn'");
    expect(page).toContain('resolveAddressCandidates(addressQuery, 1)');
    expect(page).not.toContain("rpc('manage_crm_site_boundary'");
    expect(page).not.toContain("rpc('save_site_boundary'");
    expect(page).not.toContain("rpc('save_zone_boundary'");
    expect(page).not.toContain("rpc('set_site_geometry'");
    expect(page).toContain('Every rung lands as a proposal.');
  });

  it('accepts only through the governed decision with the edited shape, and verification stays an explicit human confirmation', () => {
    expect(page).toContain("supabase.rpc('accept_boundary_proposal'");
    expect(page).toContain('p_final_geojson: proposalEdited && editRing ? ringPolygon(editRing) : null');
    expect(page).toContain('p_verify: visualReviewConfirmed');
    expect(page).toContain("supabase.rpc('reject_boundary_proposal'");
    expect(page).toContain("throw new Error('A rejection reason is required.')");
    expect(page).toContain("supabase.rpc('verify_boundary'");
    expect(page).toContain('visualReviewConfirmed');
    expect(page).toContain('disabled={busy !== null || !visualReviewConfirmed}');
    expect(page).toContain('I inspected the full boundary against the {inspectionTarget}.');
  });

  it('is loud about P1 states and the area gate instead of hiding them', () => {
    expect(page).toContain('unresolved_no_geofence');
    expect(page).toContain('unresolved_unverified');
    expect(page).toContain('Outside band — cannot be accepted as drawn');
    expect(page).toContain('it cannot be accepted as drawn');
    expect(page).toContain("'Geometry required'");
    expect(page).toContain("'Visual review required'");
    expect(page).toContain("'Proposal awaiting decision'");
  });

  it('keeps the point-radius rung provisional and offers a keyboard path', () => {
    expect(page).toContain('always provisional');
    expect(page).toContain('Keyboard users: use point + radius.');
    expect(page).toContain('aria-label="Radius in metres"');
  });
});