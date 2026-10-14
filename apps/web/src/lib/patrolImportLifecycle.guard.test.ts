import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const importer = readFileSync(resolve(process.cwd(), '../../scripts/import-patrol-log.mjs'), 'utf8');
const atlas = readFileSync(resolve(process.cwd(), '../../scripts/atlas-refresh.js'), 'utf8');

describe('governed patrol import lifecycle', () => {
  it('binds source and derivative provenance before staging', () => {
    expect(importer).toContain("createHash('sha256').update(raw).digest('hex')");
    expect(importer).toContain('source_sha256: immutableSourceHash');
    expect(importer).toContain('row.payload.derivative_sha256 = derivativeHash');
    expect(importer).toContain('classification_profile: SOURCE_PROFILE');
  });

  it('uses the begin, stage, and finalize authorities in order', () => {
    const begin = importer.indexOf('public.begin_patrol_import_batch(');
    const stage = importer.indexOf('public.stage_patrol_import_chunk(');
    const finalize = importer.indexOf('public.finalize_patrol_import_batch(');
    expect(begin).toBeGreaterThan(0);
    expect(stage).toBeGreaterThan(begin);
    expect(finalize).toBeGreaterThan(stage);
    expect(importer).toContain("finalized?.status !== 'needs_review'");
  });

  it('does not directly mutate evidence or consequential records', () => {
    expect(importer).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+|FROM\s+)?public\.(?:observations|location_events|canonical_vehicles)/i);
    expect(importer).toContain('direct_workshop_writes: 0');
    expect(importer).toContain('direct_finance_writes: 0');
  });

  it('keeps dry-run local and write-free', () => {
    const dryRun = importer.indexOf("if (mode === 'dry-run')");
    const firstQuery = importer.indexOf('await runSql(');
    expect(dryRun).toBeGreaterThan(0);
    expect(firstQuery).toBeGreaterThan(dryRun);
    expect(importer).toContain("next_status_on_apply: 'needs_review'");
  });
});

describe('Atlas direct SQL callers', () => {
  it('registers only known RPCs selected or performed by source code', () => {
    expect(atlas).toContain('(?:SELECT|PERFORM|LATERAL)');
    expect(atlas).toContain('knownEntities.rpcs.has(match[1])');
    expect(atlas).toContain('SQL call public.${match[1]}(...)');
  });
});
