/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const page = readFileSync(resolve(process.cwd(), 'src/pages/CCTVImportPage.tsx'), 'utf8');
const shell = readFileSync(resolve(process.cwd(), 'src/shells/AdminShell.tsx'), 'utf8');
const fieldOps = readFileSync(resolve(process.cwd(), 'src/pages/FieldOperationsPage.tsx'), 'utf8');
const review = readFileSync(resolve(process.cwd(), 'src/pages/CCTVReviewPage.tsx'), 'utf8');

describe('CCTV import — the place comes first, files are classified locally, writes go through governed RPCs', () => {
  it('requires a house before anything is created and never takes a free-text address', () => {
    expect(page).toContain("Choose the place this camera watches before importing. Cameras carry no GPS.");
    expect(page).toContain("supabase.from('locations').select('id, name, address, organization_id')");
    expect(page).toContain('New places are created in CRM from a LINZ address, never typed here.');
    expect(page).not.toMatch(/setAddress\(|p_address|address_match_key/);
    expect(page).not.toContain("supabase.rpc('manage_crm_location'");
    expect(page).toContain("p_watermark_location_hint: watermarkHint.trim() || null");
    expect(page).toContain('Location text in the video watermark (hint only)');
  });

  it('creates, registers and records only through the P2 RPCs', () => {
    for (const rpc of ['create_cctv_import', 'set_cctv_import_manifest', 'register_cctv_import_video', 'record_cctv_device_events']) {
      expect(page).toContain(`supabase.rpc('${rpc}'`);
    }
    expect(page).not.toContain("supabase.from('evidence_items')");
    expect(page).not.toContain("supabase.from('inference_jobs')");
    expect(page).not.toContain("supabase.from('cctv_imports').insert");
    expect(page).not.toContain("functions.invoke('register-desktop-video-import'");
  });

  it('uploads into the import folder with resumable TUS for large files and treats an existing object as done', () => {
    expect(page).toContain('storagePathFor(organizationId, importId, item.relativePath)');
    expect(page).toContain("endpoint: `${import.meta.env.VITE_SUPABASE_URL}/storage/v1/upload/resumable`");
    expect(page).toContain("'x-upsert': 'false'");
    expect(page).toContain('upload.findPreviousUploads()');
    expect(page).toContain('isAlreadyStored(uploadError)');
    expect(page).toContain("window.addEventListener('beforeunload', warn)");
  });

  it('classifies the folder client-side and derives the device timeline from snapshots', () => {
    expect(page).toContain('classifyFolder(rawInputs, timeZone)');
    expect(page).toContain('detectDeviceKind(inputs.map((input) => input.relativePath))');
    expect(page).toContain('buildDeviceEvents(scanned, (item) => snapshotPaths.get(item.relativePath) ?? null)');
    expect(page).toContain('Empty slots skipped');
    expect(page).toContain('showDirectoryPicker');
    expect(page).toContain('webkitdirectory=""');
  });

  it('is reachable as a field-ops area and from the review page', () => {
    expect(shell).toContain("case 'cctv-import':");
    expect(shell).toContain("'cctv-import'");
    expect(fieldOps).toContain("area: 'cctv-import'");
    expect(review).toContain("navigate('/admin/field-ops?area=cctv-import')");
    expect(page).toContain('navigate(`/admin/field-ops?area=cctv-review&import=${importRow.id}`)');
  });
});
