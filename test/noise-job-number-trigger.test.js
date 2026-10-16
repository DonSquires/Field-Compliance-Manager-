const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(
  path.resolve(
    __dirname,
    '../supabase/migrations/20261016215632_wire_noise_job_number_trigger.sql',
  ),
  'utf8',
);
const schema = fs.readFileSync(
  path.resolve(__dirname, '../supabase/schema.sql'),
  'utf8',
);

test('new noise assessments receive one unique operational job number', () => {
  assert.match(
    migration,
    /CREATE UNIQUE INDEX IF NOT EXISTS idx_noise_assessments_job_number_unique[\s\S]*WHERE job_number IS NOT NULL/,
  );
  assert.match(migration, /RETURNS trigger/);
  assert.match(
    migration,
    /IF nullif\(trim\(coalesce\(NEW\.job_number, ''\)\), ''\) IS NULL THEN\s+NEW\.job_number := public\.generate_noise_job_number\(\)/,
  );
  assert.match(
    migration,
    /CREATE TRIGGER noise_assessments_assign_job_number\s+BEFORE INSERT ON public\.noise_assessments/,
  );
});

test('the trigger boundary is fixed-path and not directly browser-callable', () => {
  assert.match(
    migration,
    /REVOKE ALL ON FUNCTION public\.generate_noise_job_number\(\)\s+FROM PUBLIC, anon, authenticated/,
  );
  assert.match(migration, /SECURITY DEFINER\s+SET search_path TO 'public'/);
  assert.match(
    migration,
    /REVOKE ALL ON FUNCTION public\.assign_noise_job_number\(\)\s+FROM PUBLIC, anon, authenticated/,
  );
  assert.match(
    schema,
    /CREATE TRIGGER "noise_assessments_assign_job_number" BEFORE INSERT ON public\."noise_assessments"[\s\S]*?"assign_noise_job_number"\(\)/,
  );
  assert.match(
    schema,
    /CREATE UNIQUE INDEX "idx_noise_assessments_job_number_unique"[\s\S]*?WHERE \(job_number IS NOT NULL\)/,
  );
});
