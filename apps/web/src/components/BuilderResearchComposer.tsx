import React, { useEffect, useRef, useState } from 'react';
import { Paperclip, X } from 'lucide-react';
import { supabase } from '../lib/supabase';

const TYPES: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', csv: 'text/csv', txt: 'text/plain', md: 'text/plain',
};
interface StagedFile { id: string; file: File; type: string; status: string }
interface ResearchFile {
  id: string; file_name: string; file_type: string; file_size_bytes: number;
  storage_path: string; sha256: string; extracted_text: string;
}

export function BuilderResearchComposer({ threadId, question, disabled, onSent, onError, onBusy }: {
  threadId: string; question: string; disabled: boolean; onSent: () => void; onError: (message: string) => void; onBusy: (value: boolean) => void;
}) {
  const [files, setFiles] = useState<StagedFile[]>([]);
  const [approved, setApproved] = useState(false);
  const [webSearch, setWebSearch] = useState(true);
  const [urls, setUrls] = useState('');
  const [sending, setSending] = useState(false);
  const prepared = useRef(new Map<string, ResearchFile>());
  const uploaded = useRef(new Map<string, string>());
  const request = useRef<string | null>(null);
  useEffect(() => { setApproved(false); }, [question]);
  const busy = disabled || sending;
  const changed = () => { setApproved(false); };
  const stage = (selected: FileList | null) => {
    if (!selected) return;
    changed();
    const next: StagedFile[] = [];
    if (files.length + selected.length > 5) { onError('Attach up to five research files.'); return; }
    for (const file of Array.from(selected)) {
      const type = TYPES[file.name.split('.').pop()?.toLowerCase() || ''];
      if (!type || (file.type && file.type !== type)) { onError(`${file.name}: unsupported or mismatched file type.`); return; }
      if (!file.size || file.size > (type.startsWith('image/') ? 10 : 20) * 1024 * 1024) { onError(`${file.name}: images must be 1 byte to 10 MB; documents 1 byte to 20 MB.`); return; }
      next.push({ id: crypto.randomUUID(), file, type, status: 'Ready to prepare' });
    }
    setFiles(current => [...current, ...next]);
  };
  const send = async () => {
    if (busy || !approved || !question.trim()) return;
    if (question.trim().length > 2000) { onError('Keep the public research question within 2000 characters.'); return; }
    const sourceUrls = urls.split('\n').map(value => value.trim()).filter(Boolean);
    if (sourceUrls.length > 6) { onError('Use up to six public source URLs.'); return; }
    try {
      for (const value of sourceUrls) {
        const url = new URL(value);
        if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port) throw new Error('Source URLs must be HTTPS without credentials, query strings, fragments or custom ports.');
      }
    } catch (error) { onError(error instanceof Error ? error.message : 'Invalid source URL.'); return; }
    setSending(true);
    onBusy(true);
    onError('');
    let preparingId: string | null = null;
    try {
      const { data, error: authError } = await supabase.auth.getUser();
      if (authError || !data.user) throw new Error('Sign in again before uploading research files.');
      const ready: ResearchFile[] = [];
      for (const item of files) {
        const cached = prepared.current.get(item.id);
        if (cached) { ready.push(cached); continue; }
        preparingId = item.id;
        setFiles(current => current.map(file => file.id === item.id ? { ...file, status: 'Preparing private upload' } : file));
        const bytes = await item.file.arrayBuffer();
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        const sha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
        const safeName = item.file.name.replace(/[^A-Za-z0-9._-]/g, '_').slice(-180);
        const path = `desktop/${data.user.id}/builder-chat/${threadId}/${item.id}-${safeName}`;
        const { error: uploadError } = await supabase.storage.from('bob-uploads').upload(path, item.file, { contentType: item.type, upsert: false });
        if (uploadError && !/already exists|duplicate/i.test(uploadError.message)) throw uploadError;
        uploaded.current.set(item.id, path);
        let text = '';
        if (!item.type.startsWith('image/')) {
          setFiles(current => current.map(file => file.id === item.id ? { ...file, status: 'Extracting document privately' } : file));
          const { data: extraction, error: extractionError } = await supabase.functions.invoke('bob-extract-document', { body: { file_name: item.file.name, storage_bucket: 'bob-uploads', storage_path: path } });
          if (extractionError) throw extractionError;
          if (extraction?.checksum !== sha256 || typeof extraction?.text !== 'string' || !extraction.text.trim()) throw new Error(`${item.file.name}: no verified readable document text. Scanned PDFs need OCR; Bob has not read the file.`);
          text = extraction.text.slice(0, 12000);
        }
        const result = { id: item.id, file_name: item.file.name, file_type: item.type, file_size_bytes: item.file.size, storage_path: path, sha256, extracted_text: text };
        prepared.current.set(item.id, result);
        ready.push(result);
        setFiles(current => current.map(file => file.id === item.id ? { ...file, status: 'Prepared' } : file));
        preparingId = null;
      }
      request.current ??= crypto.randomUUID();
      const { error } = await supabase.rpc('builder_chat_send_research', {
        p_thread_id: threadId, p_content: question.trim(), p_client_request_id: request.current,
        p_files: ready, p_urls: sourceUrls.map(value => new URL(value).toString()), p_web_search: webSearch, p_allow_cloud: approved,
      });
      if (error) throw error;
      setFiles([]); prepared.current.clear(); uploaded.current.clear(); request.current = null; setApproved(false); setUrls('');
      onSent();
    } catch (error) {
      if (preparingId) setFiles(current => current.map(file => file.id === preparingId ? { ...file, status: 'Preparation failed; retry or remove' } : file));
      onError(error && typeof error === 'object' && 'message' in error ? String(error.message) : 'Research preparation failed. No research completion is claimed.');
    } finally { setSending(false); onBusy(false); }
  };
  const remove = async (id: string) => {
    const path = uploaded.current.get(id);
    if (path && request.current) {
      onError('A research submission was attempted. Retry to confirm its result before removing a prepared upload; it may already belong to the queued message.');
      return;
    }
    if (path) {
      setSending(true); onBusy(true);
      try {
        const { error } = await supabase.storage.from('bob-uploads').remove([path]);
        if (error) { onError(`Could not remove staged upload: ${error.message}`); return; }
      } catch (error) {
        onError(`Could not remove staged upload: ${error instanceof Error ? error.message : 'storage request failed'}`);
        return;
      } finally { setSending(false); onBusy(false); }
    }
    setFiles(current => current.filter(item => item.id !== id));
    prepared.current.delete(id); uploaded.current.delete(id); changed();
  };
  return <fieldset className="bchat-research" disabled={busy}>
    <legend>Public cloud research</legend>
    <p>Ollama Cloud first, no metered providers. Only this question and selected files; no previous chat or private repository context.</p>
    <label><input type="checkbox" checked={webSearch} onChange={event => { setWebSearch(event.target.checked); changed(); }} /> Search the public web</label>
    <label>Source URLs (one per line, optional)<textarea rows={2} value={urls} onChange={event => { setUrls(event.target.value); changed(); }} /></label>
    <label className="bchat-research__file"><Paperclip size={14} /> Add images or documents<input aria-label="Research attachments" type="file" multiple accept={Object.values(TYPES).join(',')} onChange={event => { stage(event.target.files); event.target.value = ''; }} /></label>
    <small>JPEG/PNG/WebP: 10 MB. PDF/DOCX/XLSX/CSV/TXT: 20 MB. Five files max. Documents use up to 12,000 extracted characters, not raw files; XLSX uses one selected populated sheet. Images use verified cloud vision. Empty/scanned PDFs are reported unreadable.</small>
    <ul>{files.map(file => <li key={file.id}><span role="status">{file.file.name} · {file.status}</span><button type="button" aria-label={`Remove ${file.file.name}`} onClick={() => void remove(file.id)}><X size={14} /></button></li>)}</ul>
    <label><input type="checkbox" checked={approved} onChange={event => setApproved(event.target.checked)} /> I reviewed this question, URLs and files: no personal, confidential, restricted, credential or proprietary information. Allow this message and selected non-sensitive images/document text to Ollama Cloud.</label>
    <button type="button" disabled={busy || !approved || !question.trim()} onClick={() => void send()}>{sending ? 'Preparing research...' : 'Send approved cloud research'}</button>
  </fieldset>;
}
