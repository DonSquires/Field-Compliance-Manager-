import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ attach: vi.fn(), from: vi.fn(), select: vi.fn(), eq: vi.fn(), order: vi.fn(), storageFrom: vi.fn(), sign: vi.fn() }));
vi.mock('../lib/supabase', () => ({ supabase: { from: mocks.from, storage: { from: mocks.storageFrom } } }));
vi.mock('../lib/officerRecordPhotos', async (original) => ({
  ...await original<typeof import('../lib/officerRecordPhotos')>(), attachOfficerPhoto: mocks.attach,
}));
import { OfficerPhotoAttachments } from './OfficerPhotoAttachments';

const target = { kind: 'incident' as const, id: '10000000-0000-4000-8000-000000000001', organizationId: '20000000-0000-4000-8000-000000000001' };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.from.mockReturnValue({ select: mocks.select });
  mocks.select.mockReturnValue({ eq: mocks.eq });
  mocks.eq.mockReturnValue({ eq: mocks.eq, order: mocks.order });
  mocks.order.mockResolvedValue({ data: [], error: null });
  mocks.storageFrom.mockReturnValue({ createSignedUrl: mocks.sign });
  mocks.sign.mockResolvedValue({ data: { signedUrl: 'https://synthetic.invalid/private-photo' }, error: null });
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:synthetic-photo') });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
});
afterEach(cleanup);
const choose = () => fireEvent.change(screen.getByLabelText('Choose evidence photos from gallery'), {
  target: { files: [new File(['synthetic source'], 'synthetic.png', { type: 'image/png' })] },
});

describe('officer camera/gallery attachment behavior', () => {
  it('allows independent camera and gallery choices, previews and removes a pending source without upload', async () => {
    render(<OfficerPhotoAttachments target={target} />);
    expect(screen.getByLabelText('Take evidence photo').getAttribute('capture')).toBe('environment');
    expect(screen.getByLabelText('Choose evidence photos from gallery').hasAttribute('capture')).toBe(false);
    choose();
    expect(await screen.findByAltText('Selected photo: synthetic.png')).toBeTruthy();
    expect(screen.getByText('Pending — not uploaded')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove selection' }));
    expect(screen.queryByAltText('Selected photo: synthetic.png')).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:synthetic-photo');
    expect(mocks.attach).not.toHaveBeenCalled();
  });
  it('retains failed selections and retries only the attachment until its receipt is confirmed', async () => {
    mocks.attach.mockRejectedValueOnce(new Error('Report saved, attachment not confirmed. Retry photo only.')).mockResolvedValueOnce({});
    const onPendingChange = vi.fn();
    render(<OfficerPhotoAttachments target={target} onPendingChange={onPendingChange} />);
    choose();
    fireEvent.click(screen.getByRole('button', { name: 'Upload / retry unconfirmed photos' }));
    expect(await screen.findByText('Failed — attachment not confirmed')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('Retry photo only');
    fireEvent.click(screen.getByRole('button', { name: 'Upload / retry unconfirmed photos' }));
    expect(await screen.findByText('Confirmed — private, pending review')).toBeTruthy();
    await waitFor(() => expect(onPendingChange).toHaveBeenLastCalledWith(false));
    expect(mocks.attach).toHaveBeenCalledTimes(2);
    expect(mocks.attach.mock.calls[0][0]).toEqual(target);
    expect(mocks.attach.mock.calls[0][1]).toBe(mocks.attach.mock.calls[1][1]);
    expect(mocks.attach.mock.calls[0][2]).toBe(mocks.attach.mock.calls[1][2]);
    expect(screen.queryByRole('button', { name: 'Remove selection' })).toBeNull();
  });
  it('announces upload progress and prevents concurrent selection/removal', async () => {
    let confirm!: (value: object) => void;
    mocks.attach.mockImplementation(() => new Promise((resolve) => { confirm = resolve; }));
    render(<OfficerPhotoAttachments target={target} />);
    choose();
    fireEvent.click(screen.getByRole('button', { name: 'Upload / retry unconfirmed photos' }));
    expect(await screen.findByText('Uploading and confirming…')).toBeTruthy();
    expect((screen.getByLabelText('Take evidence photo') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Remove selection' }) as HTMLButtonElement).disabled).toBe(true);
    confirm({});
    expect(await screen.findByText('Confirmed — private, pending review')).toBeTruthy();
  });
  it('reloads persisted evidence links with short-lived private previews, not public URLs', async () => {
    mocks.order.mockResolvedValue({ data: [{
      id: 'attachment', evidence_id: 'evidence', storage_path: 'synthetic-path',
      original_name: 'saved.png', selected_at: '2026-11-06T00:00:00Z', sha256_hash: 'a'.repeat(64),
    }], error: null });
    render(<OfficerPhotoAttachments target={target} />);
    const image = await screen.findByAltText('Private source photo: saved.png');
    expect(image.getAttribute('src')).toBe('https://synthetic.invalid/private-photo');
    expect(mocks.eq).toHaveBeenCalledWith('incident_id', target.id);
    expect(mocks.eq).toHaveBeenCalledWith('organization_id', target.organizationId);
    expect(mocks.storageFrom).toHaveBeenCalledWith('officer-record-photos');
    expect(mocks.sign).toHaveBeenCalledWith('synthetic-path', 900);
    fireEvent.error(image);
    expect(screen.getByText('Preview unavailable. Refresh to retry.')).toBeTruthy();
  });
  it('does not silently fallback when the governed evidence service is unavailable', async () => {
    mocks.order.mockResolvedValue({ data: null, error: { message: 'permission denied' } });
    render(<OfficerPhotoAttachments target={target} />);
    expect((await screen.findByRole('alert')).textContent).toContain('no public-storage fallback');
    expect(mocks.storageFrom).not.toHaveBeenCalled();
  });
});
