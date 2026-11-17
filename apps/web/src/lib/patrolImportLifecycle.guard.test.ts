import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const importer = readFileSync(resolve(process.cwd(), '../../scripts/import-patrol-log.mjs'), 'utf8');
const atlas = readFileSync(resolve(process.cwd(), '../../scripts/atlas-refresh.js'), 'utf8');

describe('governed patrol import lifecycle', () => {
  it('binds source and derivative provenance before staging', () => {
    expect(importer).toContain("const derivativeHash = createHash('sha256').update(derivativeInput).digest('hex');");
    expect(importer).toContain("const inputHash = createHash('sha256').update(sourceBytes).digest('hex');");
    expect(importer).toContain('sourceHash.toLowerCase() !== inputHash');
    expect(importer).toContain('const effectiveSourceHash = sourceHash ?? inputHash;');
    expect(importer).toContain('source_sha256: effectiveSourceHash');
    expect(importer).toContain('derivative_sha256: derivativeHash');
    expect(importer).toContain('classification_profile: classificationProfile');
  });

  it('uses the begin, stage, and finalize authorities in order', () => {
    expect(importer).toContain('public.begin_patrol_import_batch(');
    expect(importer).toContain('public.stage_patrol_import_chunk(');
    expect(importer).toContain('public.finalize_patrol_import_batch(');
    const begin = importer.indexOf("const batchId = mode === 'apply' ? await ensureImportBatch() : null");
    const stage = importer.indexOf('const row = await runChunk(obsSlice, evtSlice, proposalSlice, batchId)');
    const finalize = importer.indexOf("if (mode === 'apply') await finalizeImportBatch");
    expect(begin).toBeGreaterThan(0);
    expect(stage).toBeGreaterThan(begin);
    expect(finalize).toBeGreaterThan(stage);
  });

  it('does not directly mutate evidence or consequential records', () => {
    expect(importer).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+|FROM\s+)?public\.(?:observations|location_events|canonical_vehicles)/i);
    expect(importer).toContain('direct_workshop_writes: 0');
    expect(importer).toContain('direct_finance_writes: 0');
  });

  it('keeps dry-run local and write-free', () => {
    expect(importer).toContain("const batchId = mode === 'apply' ? await ensureImportBatch() : null");
    expect(importer).toContain("${mode === 'apply' ? 'COMMIT;' : 'ROLLBACK;'}");
    expect(importer).toContain("if (mode === 'apply') await finalizeImportBatch");
  });
});

describe('Atlas direct SQL callers', () => {
  it('registers only known RPCs selected or performed by source code', () => {
    expect(atlas).toContain('(?:SELECT|PERFORM|LATERAL)');
    expect(atlas).toContain('knownEntities.rpcs.has(match[1])');
    expect(atlas).toContain('SQL call public.${match[1]}(...)');
  });
});
