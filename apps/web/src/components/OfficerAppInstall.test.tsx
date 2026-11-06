import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OfficerAppInstall } from './OfficerAppInstall';
describe('officer home-screen installation', () => {
  beforeEach(() => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Android Chrome' });
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
  it('offers honest browser-menu guidance without a native prompt', () => {
    render(<OfficerAppInstall />);
    fireEvent.click(screen.getByRole('button', { name: 'Install FCM on this phone' }));
    expect(screen.getByText(/Install app or Add to Home screen/)).toBeTruthy();
    expect(screen.getByText(/does not guarantee background GPS/)).toBeTruthy();
  });
  it('shows Safari instructions on iPhone', () => {
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'iPhone Safari' });
    render(<OfficerAppInstall />);
    fireEvent.click(screen.getByRole('button', { name: 'Install FCM on this phone' }));
    expect(screen.getByText(/tap Share, then Add to Home Screen/)).toBeTruthy();
  });
  it('opens the install prompt only after a click and handles cancellation', async () => {
    render(<OfficerAppInstall />);
    const prompt = vi.fn().mockResolvedValue(undefined);
    const event = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), { prompt, userChoice: Promise.resolve({ outcome: 'dismissed' }) });
    fireEvent(window, event);
    expect(prompt).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Install FCM on this phone' }));
    await waitFor(() => expect(prompt).toHaveBeenCalledOnce());
    expect(await screen.findByText(/Installation cancelled/)).toBeTruthy();
  });
  it('does not claim installation on a rejected prompt', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(<OfficerAppInstall />);
    fireEvent(window, Object.assign(new Event('beforeinstallprompt'), { prompt: vi.fn().mockRejectedValue(new Error('synthetic failure')), userChoice: Promise.resolve({ outcome: 'accepted' }) }));
    fireEvent.click(screen.getByRole('button', { name: 'Install FCM on this phone' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('Installation was not confirmed'));
  });
  it('removes the install action after browser confirmation', async () => {
    render(<OfficerAppInstall />);
    fireEvent(window, new Event('appinstalled'));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Install FCM on this phone' })).toBeNull());
  });
});
