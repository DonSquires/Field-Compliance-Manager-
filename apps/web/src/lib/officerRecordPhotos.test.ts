import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), upload: vi.fn(), from: vi.fn(), hash: vi.fn() }));
vi.mock('./supabase', () => ({ supabase: { rpc: mocks.rpc, storage: { from: mocks.from } } }));
vi.mock('./importPreview', () => ({ sha256Hex: mocks.hash }));
import { attachOfficerPhoto, officerPhotoPath, validateOfficerPhoto, validateOfficerPhotoReceipt } from './officerRecordPhotos';

const target = { kind: 'field_report' as const, id: '10000000-0000-4000-8000-000000000001', organizationId: '20000000-0000-4000-8000-000000000001' };
const hash = 'a'.repeat(64);
const shift = '30000000-0000-4000-8000-000000000001';
const receipt = {
  attachment_id: '40000000-0000-4000-8000-000000000001', evidence_id: '50000000-0000-4000-8000-000000000001',
  record_kind: target.kind, record_id: target.id, organization_id: target.organizationId,
  shift_id: shift, sha256: hash, storage_path: officerPhotoPath(target, hash), privacy_review_status: 'pending',
};
const bytes = new Uint8Array([137, 80, 78, 71]).buffer;
function photo() {
  const file = new File([bytes], 'synthetic.png', { type: 'image/png' });
  Object.defineProperty(file, 'arrayBuffer', { value: async () => bytes });
  return file;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.from.mockReturnValue({ upload: mocks.upload });
  mocks.hash.mockResolvedValue(hash);
  mocks.upload.mockResolvedValue({ error: null });
  mocks.rpc.mockImplementation(async (name: string) => name === 'officer_photo_target_context'
    ? { data: [{ organization_id: target.organizationId, shift_id: shift }], error: null }
    : { data: receipt, error: null });
});

describe('officer source photo attachments', () => {
  it('preflights authorization, hashes/uploads unchanged bytes privately, then validates the exact receipt', async () => {
    const file = photo();
    expect(await attachOfficerPhoto(target, file, '2026-11-06T01:00:00Z')).toEqual(receipt);
    expect(mocks.hash).toHaveBeenCalledWith(bytes);
    expect(mocks.from).toHaveBeenCalledWith('officer-record-photos');
    expect(mocks.upload).toHaveBeenCalledWith(officerPhotoPath(target, hash), file, { contentType: 'image/png', upsert: false });
    expect(mocks.rpc.mock.calls.map(([name]) => name)).toEqual(['officer_photo_target_context', 'attach_officer_record_photo']);
    expect(mocks.rpc).toHaveBeenLastCalledWith('attach_officer_record_photo', expect.objectContaining({ p_original_name: file.name, p_selected_at: '2026-11-06T01:00:00Z' }));
  });
  it('fails closed before uploading when record authorization or organization is not confirmed', async () => {
    mocks.rpc.mockResolvedValue({ data: [{ organization_id: 'wrong', shift_id: null }], error: null });
    await expect(attachOfficerPhoto(target, photo(), new Date().toISOString())).rejects.toThrow('access could not be confirmed');
    expect(mocks.upload).not.toHaveBeenCalled();
  });
  it('retries registration after a duplicate object without creating another report or overwriting evidence', async () => {
    mocks.upload.mockResolvedValue({ error: { statusCode: '409', message: 'Asset Already Exists' } });
    await expect(attachOfficerPhoto(target, photo(), new Date().toISOString())).resolves.toEqual(receipt);
    expect(mocks.rpc.mock.calls.map(([name]) => name)).not.toContain('submit_officer_field_report');
  });
  it('explains partial success and never registers after failed storage', async () => {
    mocks.upload.mockResolvedValue({ error: { message: 'Offline', statusCode: '503' } });
    await expect(attachOfficerPhoto(target, photo(), new Date().toISOString())).rejects.toThrow('saved report or incident remains');
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    mocks.upload.mockResolvedValue({ error: null });
    mocks.rpc.mockResolvedValueOnce({ data: [{ organization_id: target.organizationId, shift_id: null }], error: null })
      .mockResolvedValueOnce({ error: { message: 'offline' } });
    await expect(attachOfficerPhoto(target, photo(), new Date().toISOString())).rejects.toThrow('may be uploaded');
  });
  it.each(['record_id', 'record_kind', 'organization_id', 'shift_id', 'sha256', 'storage_path', 'privacy_review_status', 'evidence_id', 'attachment_id'])('rejects a mismatched %s in a nominally successful receipt', (key) => {
    expect(() => validateOfficerPhotoReceipt({ ...receipt, [key]: 'wrong' }, target, hash, shift)).toThrow('receipt was not confirmed');
  });
  it('validates incident targets and an explicitly unlinked shift', () => {
    const incident = { ...target, kind: 'incident' as const };
    expect(validateOfficerPhotoReceipt({ ...receipt, record_kind: 'incident', shift_id: null, storage_path: officerPhotoPath(incident, hash) }, incident, hash, null).record_kind).toBe('incident');
  });
  it('rejects empty, unsupported and oversized photos before any request', () => {
    expect(() => validateOfficerPhoto(new File([], 'empty.jpg', { type: 'image/jpeg' }))).toThrow('non-empty');
    expect(() => validateOfficerPhoto(new File(['x'], 'bad.svg', { type: 'image/svg+xml' }))).toThrow('JPEG');
    const big = photo(); Object.defineProperty(big, 'size', { value: 15 * 1024 * 1024 + 1 });
    expect(() => validateOfficerPhoto(big)).toThrow('15 MB');
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
