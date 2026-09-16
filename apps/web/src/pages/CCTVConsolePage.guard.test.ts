import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const page = readFileSync(resolve(process.cwd(), 'src/pages/CCTVConsolePage.tsx'), 'utf8');
const tile = readFileSync(resolve(process.cwd(), 'src/components/CCTVPlayerTile.tsx'), 'utf8');
const timeline = readFileSync(resolve(process.cwd(), 'src/components/CCTVTimeline.tsx'), 'utf8');
const shell = readFileSync(resolve(process.cwd(), 'src/shells/AdminShell.tsx'), 'utf8');
const fieldOps = readFileSync(resolve(process.cwd(), 'src/pages/FieldOperationsPage.tsx'), 'utf8');
const importPage = readFileSync(resolve(process.cwd(), 'src/pages/CCTVImportPage.tsx'), 'utf8');

describe('CCTV console', () => {
  it('is driven by the place-anchored CCTV spine, scoped to the organisation', () => {
    expect(page).toContain("from('cctv_imports')");
    expect(page).toContain("locations(name, address)");
    expect(page).toContain("from('cctv_device_events')");
    expect(page).toContain("from('cctv_entity_observations')");
    expect(page).toContain(".eq('cctv_import_id', importId)");
    expect(page).toContain(".eq('organization_id', organizationId)");
    expect(page).toContain("setError('Organisation access could not be confirmed. The CCTV console is unavailable.')");
  });

  it('records every identity decision through the governed review RPC and never writes the table directly', () => {
    expect(page).toContain("supabase.rpc('review_cctv_entity_observation'");
    expect(page).toContain('p_observation_id: observation.id');
    expect(page).toContain('p_action: action');
    expect(page).not.toMatch(/from\('cctv_entity_observations'\)[\s\S]{0,400}\.(update|insert|delete)\(/);
    expect(page).not.toContain("from('canonical_vehicles')");
    expect(page).not.toContain("from('person_records')");
    expect(page).toContain("'accept_portfolio'");
    expect(page).toContain("'new_person'");
    expect(page).toContain("'new_vehicle'");
    expect(page).toContain("'reject'");
  });

  it('shows the same-or-similar candidates the database found and links through them', () => {
    expect(page).toContain('observation.candidates');
    expect(page).toContain('candidateAction(observation, candidate)');
    expect(page).toContain('Same or similar on record');
  });

  it('plays every camera on one shared clock with NVR controls and keyboard shortcuts', () => {
    expect(page).toContain('clockMs');
    expect(page).toContain('isMaster={row.id === masterImportId}');
    expect(page).toContain('onTick={handleTick}');
    expect(page).toContain('PLAYBACK_RATES.map');
    expect(page).toContain('GRID_LAYOUTS.map');
    expect(page).toContain("window.addEventListener('keydown', handler)");
    expect(page).toContain('requestFullscreen');
    expect(tile).toContain('clipAtTime(clips, clockMs)');
    expect(tile).toContain('DRIFT_TOLERANCE_SECONDS');
    expect(tile).toContain('video.playbackRate = rate');
    expect(tile).toContain('onClipEnded');
    expect(tile).toContain('Converting this clip for playback');
    expect(tile).toContain('No footage at');
  });

  it('draws a severity timeline with reviewed entities dimmed and clustered marks', () => {
    expect(timeline).toContain('clusterMarks(marks, view, width)');
    expect(timeline).toContain('SEVERITY_COLOURS[cluster.severity]');
    expect(timeline).toContain("is-reviewed");
    expect(timeline).toContain('onWheel={handleWheel}');
    expect(timeline).toContain('role="slider"');
    expect(page).toContain('alert (plate read / pest)');
  });

  it('signs storage URLs for playback and snapshots instead of exposing paths', () => {
    expect(page).toContain("createSignedUrl(path, SIGNED_URL_TTL_SECONDS)");
    expect(page).toContain("createSignedUrl(mark.thumbnailPath as string, SIGNED_URL_TTL_SECONDS)");
    expect(page).toContain('clip.playbackPath ?? clip.sourcePath');
  });

  it('is wired as the CCTV review surface, with the job queue kept for exports', () => {
    expect(shell).toContain("case 'cctv-console':");
    expect(shell).toContain('<CCTVConsolePage />');
    expect(fieldOps).toContain("area: 'cctv-console', label: 'CCTV review'");
    expect(fieldOps).toContain("area: 'cctv-review', label: 'CCTV job queue & exports'");
    expect(importPage).toContain('/admin/field-ops?area=cctv-console&import=${importRow.id}');
    expect(page).toContain("new URLSearchParams(location.search).get('import')");
    expect(page).toContain("navigate('/admin/field-ops?area=cctv-review')");
    expect(page).toContain("navigate('/admin/field-ops?area=cctv-import')");
  });

  it('keeps every state honest: loading, empty, running inference, all reviewed', () => {
    expect(page).toContain('No camera footage has been imported yet');
    expect(page).toContain('Inference is still running on this footage');
    expect(page).toContain('Everything here has been reviewed');
    expect(page).toContain('No people, vehicles or animals were reported for this footage.');
    expect(page).toContain('Loading the camera’s timeline');
  });
});
