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

  it('accepts only through the governed decision with the edited shape, and verification stays an explicit human map check', () => {
    expect(page).toContain("supabase.rpc('accept_boundary_proposal'");
    expect(page).toContain('p_final_geojson: proposalEdited && editRing ? ringPolygon(editRing) : null');
    expect(page).toContain('p_verify: verify,');
    expect(page).toContain("supabase.rpc('reject_boundary_proposal'");
    expect(page).toContain("throw new Error('A rejection reason is required.')");
    expect(page).toContain("supabase.rpc('verify_boundary'");
    // Verification is its own named button; accepting alone never verifies.
    expect(page).toContain("onClick={() => void acceptProposal(false)}");
    expect(page).toContain("'Accept, verify later'");
    expect(page).toContain("onClick={() => void acceptProposal(true)}");
    expect(page).toContain("'Checked on the map — accept and verify'");
    expect(page).toContain("'Checked on the map — verify'");
    expect(page).toContain('Only verify what you have checked with your own eyes.');
  });

  it('suggests missing boundaries in bulk only as proposals, and lists every place LINZ could not resolve', () => {
    expect(page).toContain("entity.boundary_state === 'missing' && !entity.open_proposal_id && entity.center_lat != null");
    expect(page).toContain("'batch'");
    expect(page).toContain("p_proposed_via: via,");
    expect(page).toContain('nothing is verified automatically');
    expect(page).toContain("report.push({ name: entity.name, ok: false");
    expect(page).not.toMatch(/suggestAllFromLinz[\s\S]{0,1500}verify_boundary/);
    expect(page).toContain("canonical_place_inherited: 'Shared from this place");
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

  it('places and moves Tier 4 checkpoints only through the governed direct-save, and certifies them only by the map confirmation (Q3/P2)', () => {
    expect(page).toContain("supabase.rpc('manage_patrol_checkpoint'");
    expect(page).toContain("p_client_site_id: action === 'create' ? selected.entity_id : null");
    expect(page).toContain('p_organization_id: profile.organizationId');
    expect(page).not.toMatch(/from\('patrol_checkpoints'\)[\s\S]{0,300}\.(insert|update|upsert|delete)\(/);
    expect(page).toContain("p_entity_type: 'patrol_checkpoint'");
    expect(page).toContain('disabled={busy !== null || checkpointReviewed !== checkpoint.id}');
    expect(page).toContain('Position inspected on the map');
    expect(page).toContain('Every placement lands unverified; moving one resets it. Only the map confirmation certifies it.');
    expect(page).toContain('Its verification was reset — confirm the new position on the map.');
    // Radius blank means the organisation rule (Q8); the server applies it.
    expect(page).toContain("const radius = checkpointForm.radius.trim() === '' ? null : Number(checkpointForm.radius);");
    expect(page).toContain('A blank radius uses the organisation rule (platform default 5 m).');
    // A checkpoint with no point cannot be verified (P1): the verify control is not offered for it.
    expect(page).toContain("checkpoint.checkpoint_verification !== 'verified' && checkpoint.gps_lat != null && <button");
  });

  it('lets a person adjust the live boundary vertex by vertex — still as a proposal — and keeps the map where they left it', () => {
    // Adjust = propose the current shape as user_drawn, then drag / insert / remove vertices; accept carries the edited ring.
    expect(page).toContain("return propose(selected, ringPolygon(currentRing), 'user_drawn', { adjusted_from: 'current_boundary', configuration_version: selected.configuration_version, vertices: currentRing.length });");
    expect(page).toContain('Adjust current boundary');
    expect(page).toContain("marker.on('contextmenu', (event) => {");
    expect(page).toContain('ring && ring.length > 3 ? ring.filter((_, i) => i !== index) : ring');
    expect(page).toContain("className: 'workbench-vertex is-midpoint'");
    expect(page).toContain('[...ring.slice(0, index + 1), [Number(position.lng.toFixed(7)), Number(position.lat.toFixed(7))], ...ring.slice(index + 1)]');
    // Persistence: remembered base layer + viewport per place, and the selected place in the URL.
    expect(page).toContain('addLinzBaseLayers(map, { collapsed: true });');
    expect(page).toContain('const viewKey = `workbench:${selected.entity_type}:${selected.entity_id}`;');
    expect(page).toContain('rememberViewport(map, viewKey);');
    expect(page).toContain('restoreViewportOr(map, viewKey, () => {');
    expect(page).toContain("params.set('place', selectedKey);");
    expect(page).toContain('const wanted = preferredKey ?? placeParam(window.location.search);');
  });
});