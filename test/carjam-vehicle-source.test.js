const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const migration = read(
  'supabase/migrations/20261018110000_govern_vehicle_source_provenance.sql',
);
const edgeFunction = read('supabase/functions/carjam-vehicle-lookup/index.ts');
const batchScript = read('scripts/carjam-refresh-vehicle-data.js');
const parserPath = pathToFileURL(
  path.join(root, 'supabase/functions/_shared/carjamVehicle.mjs'),
).href;

const fixture = {
  message: {
    idh: {
      plate: 'CBC193',
      header: { not_found: '' },
      vehicle: {
        year_of_manufacture: '2004',
        make: 'VOLKSWAGEN',
        model: 'GOLF',
        body_style: 'HA',
        main_colour: 'Silver',
        fuel_type: '01',
      },
    },
  },
};

test('CarJam parser extracts the documented basic JSON shape and full year', async () => {
  const { parseCarjamBasicResponse } = await import(parserPath);
  assert.deepEqual(parseCarjamBasicResponse(fixture, 'cbc-193'), {
    plate: 'CBC193',
    make: 'VOLKSWAGEN',
    model: 'GOLF',
    year: 2004,
    colour: 'Silver',
    body_type: 'Hatchback',
    fuel_type: 'Petrol',
  });
});

test('CarJam parser rejects provider errors, mismatched plates and empty records', async () => {
  const { parseCarjamBasicResponse } = await import(parserPath);
  assert.throws(
    () => parseCarjamBasicResponse({ code: -1, message: 'Requires an API key' }, 'CBC193'),
    /rejected/,
  );
  assert.throws(
    () =>
      parseCarjamBasicResponse(
        {
          message: {
            idh: {
              plate: 'OTHER1',
              header: {},
              vehicle: fixture.message.idh.vehicle,
            },
          },
        },
        'CBC193',
      ),
    /different vehicle plate/,
  );
  assert.throws(
    () =>
      parseCarjamBasicResponse(
        { message: { idh: { plate: 'CBC193', header: {}, vehicle: {} } } },
        'CBC193',
      ),
    /no supported non-personal vehicle attributes/,
  );
  assert.throws(
    () => parseCarjamBasicResponse(fixture, 'TOO-LONG-PLATE'),
    /valid requested plate/,
  );
});

test('source locator credits CarJam without leaking the API key', async () => {
  const { credentialFreeCarjamSourceUrl } = await import(parserPath);
  const sourceUrl = credentialFreeCarjamSourceUrl(
    'https://www.carjam.co.nz/api/car/?key=secret',
    'cbc193',
  );
  assert.equal(
    sourceUrl,
    'https://www.carjam.co.nz/api/car/?plate=CBC193&basic=1&f=json',
  );
  assert.doesNotMatch(sourceUrl, /secret|key=/);
});

test('migration exposes attribution through the public view and keeps receipts private', () => {
  assert.match(migration, /CREATE TABLE public\.vehicle_data_sources/);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
  assert.match(
    migration,
    /REVOKE ALL ON public\.vehicle_data_sources FROM PUBLIC, anon, authenticated/,
  );
  assert.match(
    migration,
    /CREATE OR REPLACE VIEW public\.canonical_vehicle_public AS[\s\S]*external_data_source_name[\s\S]*external_data_source_url[\s\S]*external_data_source_location[\s\S]*external_data_source_checked_at/,
  );
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.record_carjam_vehicle_enrichment/);
  assert.match(migration, /FOR UPDATE/);
  assert.match(migration, /IS DISTINCT FROM v_plate/);
  assert.match(migration, /CarJam written storage authorization reference is required/);
  assert.match(
    migration,
    /source_url =\s*'https:\/\/www\.carjam\.co\.nz\/api\/car\/\?plate='\s*\|\| source_key\s*\|\| '&basic=1&f=json'/,
  );
  assert.match(
    migration,
    /external_data_source_meta = CASE[\s\S]*external_data_source_checked_at <= p_retrieved_at[\s\S]*'response_sha256', p_response_sha256/,
  );
  assert.match(migration, /Older concurrent receipts remain in history/);
  assert.match(migration, /Raw provider responses and credentials are never stored/);
});

test('edge function uses the licensed API and has no website-login or scraping fallback', () => {
  assert.match(edgeFunction, /CARJAM_API_KEY/);
  assert.match(edgeFunction, /CARJAM_STORAGE_AUTHORIZATION_REFERENCE/);
  assert.match(edgeFunction, /https:\/\/www\.carjam\.co\.nz\/api\/car\//);
  assert.match(edgeFunction, /record_carjam_vehicle_enrichment/);
  assert.match(
    edgeFunction,
    /authHeader !== `Bearer \$\{SUPABASE_SERVICE_ROLE_KEY\}`/,
  );
  assert.doesNotMatch(edgeFunction, /user_profiles|CAN_LOOKUP|SUPABASE_ANON_KEY/);
  assert.doesNotMatch(edgeFunction, /CARJAM_USERNAME|CARJAM_PASSWORD|CARJAM_COOKIE/);
  assert.doesNotMatch(edgeFunction, /text\/html|DOMParser|screen.?scrap/i);
});

test('batch enrichment is bounded, sequential and reports partial failure', () => {
  assert.match(batchScript, /CARJAM_BATCH_LIMIT/);
  assert.match(batchScript, /CARJAM_MIN_INTERVAL_MS/);
  assert.match(batchScript, /await delay\(MIN_INTERVAL_MS\)/);
  assert.match(batchScript, /if \(failed > 0\) process\.exitCode = 1/);
  assert.doesNotMatch(batchScript, /Promise\.all/);
});
