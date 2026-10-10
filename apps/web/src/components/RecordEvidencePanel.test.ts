import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { evidenceStoragePath, safeFileName } from './RecordEvidencePanel.helpers';

const panel = readFileSync(resolve(process.cwd(), 'src/components/RecordEvidencePanel.tsx'), 'utf8').replace(/\r\n/g, '\n');
const browser = readFileSync(resolve(process.cwd(), 'src/components/ActivityRecordBrowser.tsx'), 'utf8').replace(/\r\n/g, '\n');
const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20261008020000_attach_external_photo_to_record.sql'), 'utf8');
const reuseMigration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20261010214725_reuse_external_photo_evidence.sql'), 'utf8');

describe('record evidence storage path', () => {
  it('stays inside the record organisation folder the storage policy and RPC both require', () => {
    const path = evidenceStoragePath('11111111-1111-1111-1111-111111111111', 'rec-1', 'a'.repeat(64), 'Gate photo.jpg');
    expect(path.startsWith('org/11111111-1111-1111-1111-111111111111/record-evidence/')).toBe(true);
    expect(migration).toContain("'org/' || v_org::text || '/record-evidence/'");
  });

  it('cannot be steered out of the folder by a hostile file name', () => {
    const name = safeFileName('../../etc/passwd');
    expect(name).not.toContain('/');
    expect(name.startsWith('.')).toBe(false);
    expect(safeFileName('')).toBe('photo');
  });
});

describe('external photo governance', () => {
  it('registers through the governed RPC and never writes evidence rows from the browser', () => {
    expect(panel).toContain("rpc('attach_external_photo_to_record'");
    expect(panel).toContain("from('observation_supporting_evidence')");
    expect(panel).not.toMatch(/from\('evidence_items'\)\s*\.(insert|update|delete|upsert)/);
  });

  it('labels external photos as unverified and never court-ready', () => {
    expect(panel).toContain('supplied externally, not verified');
    expect(migration).toContain("'provenance', 'external'");
    expect(migration).toMatch(/is_court_ready[\s\S]{0,400}false/);
    expect(migration).toContain("'external_photo_attached'");
  });

  it('reuses identical organization evidence while preserving each observation link', () => {
    expect(reuseMigration).toContain("lower(evidence.sha256_hash) = v_hash");
    expect(reuseMigration).toContain("'external_photo_reused_for_observation'");
    expect(reuseMigration).toContain("linked_observation_ids");
    expect(reuseMigration).toContain("observation_supporting_evidence");
  });

  it('opens as an accessible dialog that Escape closes', () => {
    expect(browser).toContain('role="dialog"');
    expect(browser).toContain('aria-modal="true"');
    expect(browser).toContain("event.key === 'Escape'");
  });
});
