const assert = require('node:assert/strict');
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const test = require('node:test');
const { collectSqlFunctionEdges, normalizedFunctionSignature } = require('../scripts/atlas-refresh.js');

test('normalizes equivalent timestamp argument spellings', () => {
  assert.equal(
    normalizedFunctionSignature('sample', 'p_id uuid, p_at timestamptz DEFAULT NULL'),
    normalizedFunctionSignature('sample', 'p_id uuid, p_at timestamp with time zone'),
  );
  assert.equal(
    normalizedFunctionSignature('sample', 'p_at time'),
    normalizedFunctionSignature('sample', 'p_at time without time zone'),
  );
});

test('retains every live overload without letting historical public migrations override the schema snapshot', () => {
  const root = mkdtempSync(join(tmpdir(), 'fcm-atlas-overloads-'));
  try {
    mkdirSync(join(root, 'supabase', 'migrations'), { recursive: true });
    writeFileSync(join(root, 'supabase', 'schema.sql'), `
CREATE OR REPLACE FUNCTION public.overloaded(p_id uuid) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN PERFORM 1 FROM public.table_a; END
$f$;
CREATE OR REPLACE FUNCTION public.overloaded(p_code text) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN PERFORM 1 FROM public.table_b; END
$f$;
`);
    writeFileSync(join(root, 'supabase', 'migrations', '20260101000000_replace_uuid.sql'), `
CREATE OR REPLACE FUNCTION public.overloaded(p_id uuid) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN PERFORM 1 FROM public.table_c; END
$f$;
`);

    const targets = collectSqlFunctionEdges(root)
      .filter((edge) => edge.source_name === 'overloaded' && edge.edge_kind === 'reads')
      .map((edge) => edge.target_name)
      .sort();

    assert.deepEqual(targets, ['table_a', 'table_b']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
