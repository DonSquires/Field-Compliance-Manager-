const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const resolver = fs.readFileSync(path.join(root, 'supabase/functions/_shared/ta-boundary-resolver.ts'), 'utf8');
const preview = fs.readFileSync(path.join(root, 'supabase/functions/bob-jurisdiction-preview/index.ts'), 'utf8');
const executor = fs.readFileSync(path.join(root, 'supabase/functions/bob-proposal-execute/index.ts'), 'utf8');

test('the shared TA resolver treats NZTA token errors as a source outage and uses the Stats NZ polygon layer', () => {
  assert.match(resolver, /STATSNZ_API_KEY/);
  assert.match(resolver, /STATSNZ_TA_LAYER.*123497/);
  assert.match(resolver, /STATSNZ_TA_NAME_FIELD.*TA2026_V1_00_NAME_ASCII/);
  assert.match(resolver, /state: 'source_unavailable', source: 'nzta_featureserver'/);
  assert.match(resolver, /async function queryStatsNz/);
  assert.match(resolver, /async function geocodeTaSeed/);
  assert.match(resolver, /url\.searchParams\.set\('x', String\(seed\.lng\)\)/);
  assert.match(resolver, /url\.searchParams\.set\('y', String\(seed\.lat\)\)/);
  assert.match(resolver, /with_field_names', 'true'/);
  assert.match(resolver, /candidate\.properties\?\.\[STATSNZ_TA_NAME_FIELD\]/);
  assert.match(resolver, /Stats NZ Territorial Authority query returned no features/);
  assert.match(resolver, /source_status: 'not_found', detail: stats\.detail/);
  assert.match(resolver, /source: 'statsnz_datafinder'/);
  assert.match(resolver, /export async function resolveTaBoundary/);
});

test('preview and approved execution use the same TA boundary resolver and carry actual source provenance', () => {
  assert.match(preview, /resolveTaBoundary/);
  assert.match(preview, /source_status: resolution\.source_status/);
  assert.match(preview, /Boundary source unavailable/);
  assert.match(executor, /resolveTaBoundary/);
  assert.match(executor, /async function fetchTaBoundary/);
  assert.match(executor, /p_boundary_source: boundarySources\.size === 1/);
  assert.match(executor, /Jurisdiction boundary set from \$\{boundarySources\.size === 1/);
  assert.doesNotMatch(executor, /NZTA fetch failed|set from NZTA/);
  assert.doesNotMatch(executor, /fetchTaGeoJsonFromStatsNZ|layer=111182|TA2024_V1_00_NAME_ASCII/);
});