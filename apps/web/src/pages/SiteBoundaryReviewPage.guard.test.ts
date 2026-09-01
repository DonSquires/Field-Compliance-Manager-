/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const page = readFileSync(resolve(process.cwd(), 'src/pages/SiteBoundaryReviewPage.tsx'), 'utf8');

describe('site boundary visual review', () => {
  it('renders queue-scoped GeoJSON without reading client_sites directly', () => {
    expect(page).toContain('selected.boundary_geojson');
    expect(page).toContain('L.geoJSON');
    expect(page).not.toContain("supabase.from('client_sites')");
  });

  it('requires explicit visual confirmation before governed verification', () => {
    expect(page).toContain('visualReviewConfirmed');
    expect(page).toContain("p_action: 'verify'");
    expect(page).toContain("supabase.rpc('manage_crm_site_boundary'");
    expect(page).toContain('!visualReviewConfirmed');
  });
});