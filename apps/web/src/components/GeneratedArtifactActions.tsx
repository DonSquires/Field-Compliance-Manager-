import { useState } from 'react';
import { Download, ExternalLink } from 'lucide-react';
import { supabase } from '../lib/supabase';

interface GeneratedArtifactActionsProps {
  bucket: string;
  path: string;
  fileName: string;
  label?: string;
}

export function GeneratedArtifactActions({ bucket, path, fileName, label = 'PDF' }: GeneratedArtifactActionsProps) {
  const [busy, setBusy] = useState<'preview' | 'download' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const preview = async () => {
    const previewWindow = window.open('about:blank', '_blank');
    if (!previewWindow) {
      setError('The preview could not open. Allow pop-ups for this site and try again.');
      return;
    }
    previewWindow.opener = null;
    setBusy('preview');
    setError(null);
    try {
      const { data, error: signedUrlError } = await supabase.storage.from(bucket).createSignedUrl(path, 900);
      if (signedUrlError || !data?.signedUrl) {
        previewWindow.close();
        setError(signedUrlError?.message ?? 'The artifact preview could not be opened.');
      } else {
        previewWindow.location.replace(data.signedUrl);
      }
    } catch (previewError) {
      previewWindow.close();
      setError(previewError instanceof Error ? previewError.message : 'The artifact preview could not be opened.');
    } finally {
      setBusy(null);
    }
  };

  const download = async () => {
    setBusy('download');
    setError(null);
    try {
      const { data, error: downloadError } = await supabase.storage.from(bucket).download(path);
      if (downloadError || !data) {
        setError(downloadError?.message ?? 'The artifact could not be downloaded.');
        return;
      }
      const objectUrl = URL.createObjectURL(data);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = fileName;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
    } catch (downloadError) {
      setError(downloadError instanceof Error ? downloadError.message : 'The artifact could not be downloaded.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="generated-artifact-actions" aria-label={`${label} actions`}>
      <button type="button" className="btn btn-sm btn-secondary" onClick={() => void preview()} disabled={busy !== null} title={`Preview ${label}`}>
        <ExternalLink size={14} aria-hidden="true" /> {busy === 'preview' ? 'Opening…' : `Preview ${label}`}
      </button>
      <button type="button" className="btn btn-sm btn-secondary" onClick={() => void download()} disabled={busy !== null} title={`Download ${label}`}>
        <Download size={14} aria-hidden="true" /> {busy === 'download' ? 'Downloading…' : `Download ${label}`}
      </button>
      {error && <span className="generated-artifact-error" role="alert">{error}</span>}
    </div>
  );
}