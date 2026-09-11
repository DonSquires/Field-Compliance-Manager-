import { useEffect, useMemo, useState } from 'react';
import { AudioLines, CheckCircle2, ClipboardList, Copy, Download, FileText, GitBranch, Image as ImageIcon, Paperclip, Sparkles, Video } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { BobMarkdown } from './BobMarkdown';
import { BobMermaidDiagram } from './BobMermaidDiagram';
import './BobStudio.css';

interface StudioMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  created_at: string;
}

interface StudioAttachment {
  id: string;
  file_name: string;
  file_type: string;
  processing_state: string;
  extraction_summary: string | null;
  confidence: number | null;
  storage_bucket?: string | null;
  storage_path?: string | null;
}

type StudioTab = 'document' | 'diagram' | 'media';
type DocumentKind = 'rfq_response' | 'employment_contract' | 'report_design' | 'custom_document';

const DOCUMENT_PRESETS: Record<DocumentKind, { label: string; shortLabel: string; prompt: string; note: string }> = {
  rfq_response: {
    label: 'RFQ response',
    shortLabel: 'RFQ',
    prompt: 'Draft an RFQ response using the current context and any attached source documents. Do not invent commercial commitments. Mark every unknown as [TO CONFIRM], include assumptions, exclusions, pricing evidence placeholders, compliance responses, and a final human-review checklist.',
    note: 'Commercial draft for review; Bob must not invent pricing, commitments, or contract terms.',
  },
  employment_contract: {
    label: 'Employment contract draft',
    shortLabel: 'Employment',
    prompt: 'Draft an employment contract using the current context and any attached source documents. Treat this as a draft only. Mark missing legal, pay, classification, leave, and policy details as [TO CONFIRM], and include a named HR/legal review checklist before signature.',
    note: 'HR/legal draft only. A qualified reviewer must approve it before use or signature.',
  },
  report_design: {
    label: 'Report design',
    shortLabel: 'Report',
    prompt: 'Design a field report or client report using the current context. Return a structured markdown specification with purpose, audience, sections, evidence required, calculations, output examples, review workflow, and placeholders marked [TO CONFIRM].',
    note: 'Report design draft; suitable for review before becoming a governed report template.',
  },
  custom_document: {
    label: 'Custom document',
    shortLabel: 'Document',
    prompt: 'Draft the requested document using the current context and attachments. Use clear headings, fill only evidence-backed fields, mark unknowns as [TO CONFIRM], and finish with a human-review checklist.',
    note: 'General drafting surface for policies, letters, schedules, SOPs, and other reviewable documents.',
  },
};

const documentKindOrder: DocumentKind[] = ['rfq_response', 'employment_contract', 'report_design', 'custom_document'];

function isMediaAttachment(attachment: StudioAttachment) {
  return attachment.file_type.startsWith('image/') || attachment.file_type.startsWith('video/') || attachment.file_type.startsWith('audio/');
}

function safeFilename(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'bob-document';
}

export function extractMermaidDiagrams(messages: StudioMessage[]) {
  return messages
    .filter((message) => message.role === 'assistant')
    .flatMap((message) => [...message.content.matchAll(/```mermaid\s*([\s\S]*?)```/gi)]
      .map((match, index) => ({ id: `${message.id}-${index}`, chart: match[1].trim(), createdAt: message.created_at })))
    .reverse();
}

export function BobStudio({
  messages,
  attachments,
  onPrompt,
  onAttach,
}: {
  messages: StudioMessage[];
  attachments: StudioAttachment[];
  onPrompt: (prompt: string) => void;
  onAttach: () => void;
}) {
  const [tab, setTab] = useState<StudioTab>('document');
  const [documentKind, setDocumentKind] = useState<DocumentKind>('rfq_response');
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null);
  const [selectedDiagramId, setSelectedDiagramId] = useState<string | null>(null);
  const [selectedMediaId, setSelectedMediaId] = useState<string | null>(null);
  const [mediaUrl, setMediaUrl] = useState<string | null>(null);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const assistantMessages = useMemo(() => messages.filter((message) => message.role === 'assistant').slice().reverse(), [messages]);
  const diagrams = useMemo(() => extractMermaidDiagrams(messages), [messages]);
  const mediaAttachments = useMemo(() => attachments.filter(isMediaAttachment), [attachments]);
  const selectedDocument = assistantMessages.find((message) => message.id === selectedMessageId) ?? assistantMessages[0] ?? null;
  const selectedDiagram = diagrams.find((diagram) => diagram.id === selectedDiagramId) ?? diagrams[0] ?? null;
  const selectedMedia = mediaAttachments.find((attachment) => attachment.id === selectedMediaId) ?? mediaAttachments[0] ?? null;
  const preset = DOCUMENT_PRESETS[documentKind];

  useEffect(() => {
    if (selectedMessageId && assistantMessages.some((message) => message.id === selectedMessageId)) return;
    setSelectedMessageId(assistantMessages[0]?.id ?? null);
  }, [assistantMessages, selectedMessageId]);

  useEffect(() => {
    if (selectedDiagramId && diagrams.some((diagram) => diagram.id === selectedDiagramId)) return;
    setSelectedDiagramId(diagrams[0]?.id ?? null);
  }, [diagrams, selectedDiagramId]);

  useEffect(() => {
    if (selectedMediaId && mediaAttachments.some((attachment) => attachment.id === selectedMediaId)) return;
    setSelectedMediaId(mediaAttachments[0]?.id ?? null);
  }, [mediaAttachments, selectedMediaId]);

  useEffect(() => {
    let cancelled = false;
    setMediaUrl(null);
    setMediaError(null);
    if (!selectedMedia?.storage_path) return;
    const bucket = selectedMedia.storage_bucket || 'bob-uploads';
    supabase.storage.from(bucket).createSignedUrl(selectedMedia.storage_path, 3600)
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) setMediaError(error.message);
        else setMediaUrl(data?.signedUrl ?? null);
      })
      .catch((error: unknown) => { if (!cancelled) setMediaError(error instanceof Error ? error.message : 'Media preview could not be opened.'); });
    return () => { cancelled = true; };
  }, [selectedMedia]);

  const startDocument = (kind: DocumentKind) => {
    setDocumentKind(kind);
    setTab('document');
    onPrompt(DOCUMENT_PRESETS[kind].prompt);
  };

  const copyDocument = async () => {
    if (!selectedDocument?.content) return;
    if (!navigator.clipboard?.writeText) {
      setNotice('Clipboard is unavailable in this browser.');
      return;
    }
    await navigator.clipboard.writeText(selectedDocument.content);
    setNotice('Draft copied to the clipboard.');
  };

  const downloadDocument = () => {
    if (!selectedDocument?.content || typeof URL.createObjectURL !== 'function') return;
    const blob = new Blob([selectedDocument.content], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${safeFilename(preset.label)}-${new Date().toISOString().slice(0, 10)}.md`;
    anchor.click();
    URL.revokeObjectURL(url);
    setNotice('Draft downloaded as Markdown.');
  };

  const tabs: Array<{ id: StudioTab; label: string; count: number }> = [
    { id: 'document', label: 'Documents', count: assistantMessages.length },
    { id: 'diagram', label: 'Diagrams', count: diagrams.length },
    { id: 'media', label: 'Media', count: mediaAttachments.length },
  ];

  return (
    <section className="bob-studio" aria-label="Bob studio">
      <header className="bob-studio-header">
        <div>
          <span><Sparkles size={14} /> Bob Studio</span>
          <h2>Documents, diagrams, and media</h2>
          <p>Full-page space for evidence-backed drafts. Nothing here applies legal, commercial, HR, or operational changes without human review.</p>
        </div>
        <div className="bob-studio-header-actions"><a className="bob-studio-editor-link" href="/admin/document-studio"><FileText size={15} /> Open document editor</a><button type="button" onClick={onAttach}><Paperclip size={15} /> Add source</button></div>
      </header>

      <div className="bob-studio-tabs" role="tablist" aria-label="Studio artifact type">
        {tabs.map((item) => <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} className={tab === item.id ? 'is-active' : ''} onClick={() => setTab(item.id)}>{item.label}<em>{item.count}</em></button>)}
      </div>

      {notice && <p className="bob-studio-notice" role="status"><CheckCircle2 size={14} />{notice}</p>}

      {tab === 'document' && (
        <div className="bob-studio-document-layout">
          <aside className="bob-studio-documents" aria-label="Document types">
            {documentKindOrder.map((kind) => {
              const item = DOCUMENT_PRESETS[kind];
              return <button key={kind} type="button" className={kind === documentKind ? 'is-active' : ''} onClick={() => startDocument(kind)}><FileText size={15} /><span><strong>{item.label}</strong><small>{item.note}</small></span></button>;
            })}
          </aside>
          <section className="bob-document-stage" aria-label="Document preview">
            <header>
              <div><span>{preset.shortLabel}</span><h3>{selectedDocument ? 'Latest Bob draft' : preset.label}</h3><p>{preset.note}</p></div>
              <div>
                <button type="button" onClick={() => void copyDocument()} disabled={!selectedDocument?.content}><Copy size={14} /> Copy</button>
                <button type="button" onClick={downloadDocument} disabled={!selectedDocument?.content}><Download size={14} /> Download</button>
              </div>
            </header>
            {assistantMessages.length > 1 && <label className="bob-document-version"><span>Draft version</span><select value={selectedDocument?.id ?? ''} onChange={(event) => setSelectedMessageId(event.target.value)}>{assistantMessages.map((message) => <option key={message.id} value={message.id}>{new Date(message.created_at).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</option>)}</select></label>}
            {selectedDocument ? <article className="bob-document-sheet"><BobMarkdown content={selectedDocument.content} /></article> : <div className="bob-studio-empty"><ClipboardList size={28} /><strong>Choose a document type to brief Bob.</strong><p>Attach the RFQ, contract, policy, report example, or source evidence first when the draft depends on existing text.</p><button type="button" onClick={() => onPrompt(preset.prompt)}>Brief Bob</button></div>}
          </section>
        </div>
      )}

      {tab === 'diagram' && (
        <div className="bob-studio-diagram-layout">
          {selectedDiagram ? <>
            {diagrams.length > 1 && <div className="bob-studio-version-row"><label><span>Diagram version</span><select value={selectedDiagram.id} onChange={(event) => setSelectedDiagramId(event.target.value)}>{diagrams.map((diagram) => <option key={diagram.id} value={diagram.id}>{new Date(diagram.createdAt).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</option>)}</select></label><button type="button" onClick={() => onPrompt('Create a revised Mermaid diagram from the latest draft. Return only one mermaid code block and preserve unknowns as named nodes.')}><GitBranch size={14} /> Revise</button></div>}
            <BobMermaidDiagram chart={selectedDiagram.chart} title="Bob generated diagram" />
            <details className="bob-diagram-source"><summary>Diagram source</summary><pre>{selectedDiagram.chart}</pre></details>
          </> : <div className="bob-studio-empty"><GitBranch size={28} /><strong>No diagram yet.</strong><p>Ask Bob for a process map, accountability chart, site flow, data model, or operating sequence.</p><button type="button" onClick={() => onPrompt('Create a Mermaid diagram for the current context. Return only one mermaid code block. Use clear nodes, named decision points, and mark unknowns explicitly instead of inventing links.')}>Draft diagram</button></div>}
        </div>
      )}

      {tab === 'media' && (
        <div className="bob-studio-media-layout">
          <aside className="bob-studio-media-list" aria-label="Attached media">
            {mediaAttachments.length === 0 ? <p>No image, video, or audio evidence is attached to this session.</p> : mediaAttachments.map((attachment) => {
              const Icon = attachment.file_type.startsWith('video/') ? Video : attachment.file_type.startsWith('audio/') ? AudioLines : ImageIcon;
              return <button key={attachment.id} type="button" className={attachment.id === selectedMedia?.id ? 'is-active' : ''} onClick={() => setSelectedMediaId(attachment.id)}><Icon size={16} /><span><strong>{attachment.file_name}</strong><small>{attachment.processing_state.replaceAll('_', ' ')}{typeof attachment.confidence === 'number' ? ` · ${Math.round(attachment.confidence * 100)}% confidence` : ''}</small></span></button>;
            })}
          </aside>
          <section className="bob-media-stage" aria-label="Media preview">
            {!selectedMedia ? <div className="bob-studio-empty"><ImageIcon size={28} /><strong>Attach media to preview it here.</strong><p>Use the composer paperclip or drop files into Bob. Private storage stays private; this preview uses a short-lived signed URL.</p><button type="button" onClick={onAttach}>Attach media</button></div> : <>
              <header><div><span>{selectedMedia.file_type}</span><h3>{selectedMedia.file_name}</h3><p>{selectedMedia.extraction_summary ?? 'Extraction is still pending or no visual summary was recorded.'}</p></div></header>
              {mediaError && <p className="bob-studio-error" role="alert">{mediaError}</p>}
              {!mediaUrl && !mediaError ? <p className="bob-studio-loading">Opening private preview…</p> : selectedMedia.file_type.startsWith('video/') ? <video src={mediaUrl ?? undefined} controls preload="metadata" /> : selectedMedia.file_type.startsWith('audio/') ? <audio src={mediaUrl ?? undefined} controls /> : <img src={mediaUrl ?? undefined} alt={selectedMedia.file_name} />}
            </>}
          </section>
        </div>
      )}
    </section>
  );
}
