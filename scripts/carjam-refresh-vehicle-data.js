#!/usr/bin/env node

const { randomUUID } = require('node:crypto');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const integerSetting = (name, fallback, min, max) => {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
};

const BATCH_LIMIT = integerSetting('CARJAM_BATCH_LIMIT', 25, 1, 100);
const MIN_INTERVAL_MS = integerSetting('CARJAM_MIN_INTERVAL_MS', 1250, 1000, 60_000);
const REFRESH_AFTER_DAYS = integerSetting('CARJAM_REFRESH_AFTER_DAYS', 30, 1, 365);

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(1);
}

const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const displayPlate = (plate) => {
  const value = String(plate ?? '');
  return value.length <= 3 ? '***' : `${'*'.repeat(value.length - 3)}${value.slice(-3)}`;
};

async function main() {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const staleBefore = new Date(
    Date.now() - REFRESH_AFTER_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  const { data: vehicles, error } = await supabase
    .from('canonical_vehicles')
    .select(
      'id, plate_number, make, model, year, colour, body_type, fuel_type, external_data_source_checked_at',
    )
    .or(
      `make.is.null,model.is.null,year.is.null,colour.is.null,body_type.is.null,fuel_type.is.null,external_data_source_checked_at.is.null,external_data_source_checked_at.lt.${staleBefore}`,
    )
    .order('external_data_source_checked_at', {
      ascending: true,
      nullsFirst: true,
    })
    .limit(BATCH_LIMIT);

  if (error) throw error;
  if (!vehicles?.length) {
    console.log('No canonical vehicles require licensed CarJam enrichment.');
    return;
  }

  let succeeded = 0;
  let failed = 0;
  for (const [index, vehicle] of vehicles.entries()) {
    if (index > 0) await delay(MIN_INTERVAL_MS);
    const maskedPlate = displayPlate(vehicle.plate_number);
    const response = await fetch(
      `${SUPABASE_URL}/functions/v1/carjam-vehicle-lookup`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
        body: JSON.stringify({
          canonical_vehicle_id: vehicle.id,
          client_request_id: randomUUID(),
          plate: vehicle.plate_number,
        }),
      },
    );

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      failed += 1;
      console.error(
        `CarJam enrichment failed for ${vehicle.id} (${maskedPlate}): ${
          payload.error || `HTTP ${response.status}`
        }`,
      );
      if (response.status === 429) {
        console.error('CarJam rate limit reached; stopping this batch without retrying.');
        break;
      }
      continue;
    }

    succeeded += 1;
    console.log(
      `CarJam enrichment receipt recorded for ${vehicle.id} (${maskedPlate}).`,
    );
  }

  console.log(
    `CarJam enrichment batch complete: ${succeeded} succeeded, ${failed} failed.`,
  );
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
