import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import VehicleProfile from './VehicleProfile';

const { rpc, photo, signed, upload, onUpdated } = vi.hoisted(() => ({
  rpc: vi.fn(), photo: vi.fn(), signed: vi.fn(), upload: vi.fn(), onUpdated: vi.fn(),
}));
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ profile: { id: 'actor', organizationId: 'org' } }) }));
vi.mock('../lib/supabase', () => ({
  supabase: {
    rpc,
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: photo }) }) }),
    storage: { from: () => ({ createSignedUrl: signed, upload }) },
  },
}));
const vehicle = { id: 'vehicle', plate_number: 'ABC123', make: 'Toyota', model: null, year: 2020,
  colour: null, body_type: null, rego_expiry: null, wof_expiry: null, cof_expiry: null };

describe('vehicle profile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    photo.mockResolvedValue({ data: null, error: null });
    rpc.mockResolvedValue({ data: true, error: null });
    onUpdated.mockResolvedValue(undefined);
    signed.mockResolvedValue({ data: { signedUrl: 'https://example.invalid/private-photo' }, error: null });
    vi.stubGlobal('URL', class extends URL {
      static createObjectURL = vi.fn(() => 'blob:fixture');
      static revokeObjectURL = vi.fn();
    });
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('edits details through the audited RPC without plate, notes or identity fields', async () => {
    render(<VehicleProfile vehicle={vehicle} onUpdated={onUpdated} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit vehicle details' }));
    fireEvent.change(screen.getByLabelText('Colour'), { target: { value: 'Blue' } });
    fireEvent.change(screen.getByLabelText('Registration expiry'), { target: { value: '2027-12-01' } });
    fireEvent.change(screen.getByLabelText('Reason / source for detail changes'), { target: { value: 'Reviewed vehicle photo and licence' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save vehicle details' }));
    await screen.findByText('Vehicle details saved with audit history.');
    expect(rpc).toHaveBeenCalledWith('is_admin_for_org', { target_org_id: 'org' });
    const args = rpc.mock.calls.find(([name]) => name === 'update_vehicle_profile_details')?.[1];
    expect(args).toMatchObject({ p_vehicle_id: 'vehicle', p_organization_id: 'org',
      p_fields: { colour: 'Blue', rego_expiry: '2027-12-01', make: 'Toyota' } });
    expect(args.p_fields).not.toHaveProperty('notes');
    expect(args.p_fields).not.toHaveProperty('plate_number');
    expect(onUpdated).toHaveBeenCalledOnce();
  });

  it('keeps review errors visible and never reports a failed write as success', async () => {
    render(<VehicleProfile vehicle={vehicle} onUpdated={onUpdated} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit vehicle details' }));
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'Shared facts require review' } });
    fireEvent.change(screen.getByLabelText('Reason / source for detail changes'), { target: { value: 'Correction' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save vehicle details' }));
    expect((await screen.findByRole('alert')).textContent).toContain("couldn't load vehicle profile");
    expect(onUpdated).not.toHaveBeenCalled();
    expect(screen.queryByText('Vehicle details saved with audit history.')).toBeNull();
  });

  it('shows private signed photos to read-only users without edit controls', async () => {
    photo.mockResolvedValue({ data: { storage_path: 'private/path.webp' }, error: null });
    rpc.mockResolvedValue({ data: false, error: null });
    render(<VehicleProfile vehicle={vehicle} onUpdated={onUpdated} />);
    expect(await screen.findByRole('img', { name: 'Profile of vehicle ABC123' })).toHaveProperty('src', 'https://example.invalid/private-photo');
    expect(signed).toHaveBeenCalledWith('private/path.webp', 3600);
    expect(screen.queryByRole('button', { name: 'Edit vehicle details' })).toBeNull();
    expect(screen.getByText('Vehicle profile changes require an organisation administrator.')).toBeTruthy();
  });

  it('rejects invalid photo types before storage and keeps missing permissions explicit', async () => {
    render(<VehicleProfile vehicle={vehicle} onUpdated={onUpdated} />);
    await screen.findByRole('button', { name: 'Edit vehicle details' });
    fireEvent.click(screen.getByRole('button', { name: /^(Add|Replace) profile photo$/ }));
    fireEvent.change(screen.getByLabelText('Vehicle profile photo'), { target: {
      files: [new File(['x'], 'payload.svg', { type: 'image/svg+xml' })],
    } });
    fireEvent.change(screen.getByLabelText('Reason / source for profile photo'), { target: { value: 'Source photo' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save profile photo' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Choose a JPEG, PNG or WebP');
    expect(upload).not.toHaveBeenCalled();
  });

  it('re-encodes and hashes a photo, and retries linking without uploading twice', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ width: 2000, height: 1000, close: vi.fn() }));
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
    const blob = new Blob(['sanitised'], { type: 'image/webp' });
    Object.defineProperty(blob, 'arrayBuffer', { value: async () => new ArrayBuffer(9) });
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(callback => callback(blob));
    vi.stubGlobal('crypto', { randomUUID: () => 'upload-id', subtle: {
      digest: vi.fn().mockResolvedValue(new Uint8Array(32).fill(10).buffer),
    } });
    upload.mockResolvedValue({ data: {}, error: null });
    render(<VehicleProfile vehicle={vehicle} onUpdated={onUpdated} />);
    await screen.findByRole('button', { name: 'Edit vehicle details' });
    fireEvent.click(screen.getByRole('button', { name: /^(Add|Replace) profile photo$/ }));
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'Temporary link failure' } });
    fireEvent.change(screen.getByLabelText('Vehicle profile photo'), { target: {
      files: [new File(['source'], 'car.jpg', { type: 'image/jpeg' })],
    } });
    fireEvent.change(screen.getByLabelText('Reason / source for profile photo'), { target: { value: 'Human checked car photo' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save profile photo' }));
    await screen.findByRole('alert');
    expect(upload).toHaveBeenCalledWith('org/actor/vehicle/upload-id.webp', blob, { contentType: 'image/webp', upsert: false });
    expect(rpc).toHaveBeenCalledWith('set_vehicle_profile_photo', {
      p_organization_id: 'org', p_vehicle_id: 'vehicle', p_storage_path: 'org/actor/vehicle/upload-id.webp',
      p_sha256_hash: '0a'.repeat(32), p_reason: 'Human checked car photo',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save profile photo' }));
    await waitFor(() => expect(screen.getByText('Shared vehicle profile photo saved with audit history.')).toBeTruthy());
    expect(upload).toHaveBeenCalledOnce();
  });
});
