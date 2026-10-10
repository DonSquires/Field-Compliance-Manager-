import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GeneratedArtifactActions } from './GeneratedArtifactActions';

const storageMocks = vi.hoisted(() => ({
  createSignedUrl: vi.fn(),
  download: vi.fn(),
}));

vi.mock('../lib/supabase', () => ({
  supabase: {
    storage: {
      from: () => storageMocks,
    },
  },
}));

describe('GeneratedArtifactActions', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    storageMocks.createSignedUrl.mockReset();
    storageMocks.download.mockReset();
  });

  it('opens a time-limited signed URL for preview without retaining an opener', async () => {
    const previewWindow = {
      opener: window,
      close: vi.fn(),
      location: { replace: vi.fn() },
    } as unknown as Window;
    vi.spyOn(window, 'open').mockReturnValue(previewWindow);
    storageMocks.createSignedUrl.mockResolvedValue({ data: { signedUrl: 'https://storage.example/signed.pdf' }, error: null });

    render(<GeneratedArtifactActions bucket="notice-artifacts" path="org/notice.pdf" fileName="notice.pdf" />);
    fireEvent.click(screen.getByRole('button', { name: 'Preview PDF' }));

    await waitFor(() => expect(previewWindow.location.replace).toHaveBeenCalledWith('https://storage.example/signed.pdf'));
    expect(previewWindow.opener).toBeNull();
    expect(storageMocks.createSignedUrl).toHaveBeenCalledWith('org/notice.pdf', 900);
  });

  it('downloads the private artifact under the requested filename', async () => {
    const createObjectUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:generated-artifact');
    const scheduleRevoke = vi.spyOn(window, 'setTimeout');
    const clickAnchor = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.download).toBe('noise-evidence.pdf');
      expect(this.href).toBe('blob:generated-artifact');
    });
    storageMocks.download.mockResolvedValue({ data: new Blob(['%PDF-test'], { type: 'application/pdf' }), error: null });

    render(<GeneratedArtifactActions bucket="notice-artifacts" path="org/noise.pdf" fileName="noise-evidence.pdf" label="Evidence PDF" />);
    fireEvent.click(screen.getByRole('button', { name: 'Download Evidence PDF' }));

    await waitFor(() => expect(clickAnchor).toHaveBeenCalledOnce());
    expect(storageMocks.download).toHaveBeenCalledWith('org/noise.pdf');
    expect(createObjectUrl).toHaveBeenCalledOnce();
    expect(scheduleRevoke).toHaveBeenCalledWith(expect.any(Function), 30_000);
  });

  it('reports private-storage download failures accessibly', async () => {
    storageMocks.download.mockResolvedValue({ data: null, error: new Error('Storage unavailable') });

    render(<GeneratedArtifactActions bucket="notice-artifacts" path="org/missing.pdf" fileName="missing.pdf" />);
    fireEvent.click(screen.getByRole('button', { name: 'Download PDF' }));

    expect((await screen.findByRole('alert')).textContent).toContain('Storage unavailable');
  });

  it('recovers from rejected storage requests and re-enables the controls', async () => {
    storageMocks.download.mockRejectedValue(new Error('Network unavailable'));

    render(<GeneratedArtifactActions bucket="notice-artifacts" path="org/offline.pdf" fileName="offline.pdf" />);
    const downloadButton = screen.getByRole('button', { name: 'Download PDF' });
    fireEvent.click(downloadButton);

    expect((await screen.findByRole('alert')).textContent).toContain('Network unavailable');
    await waitFor(() => expect((downloadButton as HTMLButtonElement).disabled).toBe(false));
  });
});