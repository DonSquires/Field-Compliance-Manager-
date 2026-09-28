'use strict';

// Batch document understanding for Bob chat (action understand_documents_batch).
// Reads every attachment in a conversation, extracts text in-house (pdftotext,
// docx XML, tesseract for images), then asks the model gateway for one grounded
// synthesis. Read-only: nothing here writes a business record.

const MAX_FILES = 8;
const MAX_TEXT_PER_FILE = 12_000;
const MAX_TEXT_TOTAL = 36_000;

function fileKind(fileType, fileName) {
  const type = String(fileType || '').toLowerCase();
  const name = String(fileName || '').toLowerCase();
  if (type === 'application/pdf' || name.endsWith('.pdf')) return 'pdf';
  if (type.includes('wordprocessingml') || name.endsWith('.docx')) return 'docx';
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('text/') || /\.(txt|md|csv|json|tsv)$/.test(name)) return 'text';
  if (type.startsWith('video/') || type.startsWith('audio/')) return 'media';
  return 'other';
}

function docxXmlToText(xml) {
  return String(xml || '')
    .replace(/<w:tab\/>/g, '\t')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<w:br[^>]*\/>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function parseModelJson(content) {
  const text = String(content || '').trim();
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { return JSON.parse(text.slice(start, end + 1)); } catch { /* fall through */ }
    }
  }
  return null;
}

function buildMessages(question, files) {
  let budget = MAX_TEXT_TOTAL;
  const blocks = files.map((file, index) => {
    const text = file.text ? file.text.slice(0, Math.max(0, Math.min(MAX_TEXT_PER_FILE, budget))) : '';
    budget -= text.length;
    return `### File ${index + 1}: ${file.name} (${file.kind}${file.readable ? '' : ', not readable'})\n${text || '[no readable text]'}`;
  });
  return [
    {
      role: 'system',
      content: [
        'You are Bob, the assistant inside Field Compliance Manager, a New Zealand security and field-compliance platform.',
        'Read the uploaded files below and answer the user\'s request using only what the files say plus general professional knowledge.',
        'If the user asks you to draft something (for example an employment agreement), write the full draft in "answer" in Markdown, using the files as the template and source of facts, and mark any value you could not find as [TO CONFIRM].',
        'Never invent names, rates, dates or legal clauses as facts from the files. Nothing is written to the system; this is a read and a draft.',
        'Reply with a JSON object: {"synthesis": string (2-4 sentences on what the files are and how they relate), "answer": string (the direct answer or draft), "files": [{"name": string, "summary": string}], "suggested_action": string|null, "proposed_entities": object|null}.',
      ].join(' '),
    },
    { role: 'user', content: `Request: ${question || 'Summarise these files.'}\n\n${blocks.join('\n\n')}` },
  ];
}

function createDocumentReader({ supabase, gateway, extract }) {
  async function listAttachments(conversationId, attachmentIds) {
    let query = supabase.from('bob_attachments')
      .select('id,organization_id,conversation_id,file_name,file_type,file_size_bytes,storage_bucket,storage_path,created_at')
      .eq('conversation_id', conversationId)
      .neq('storage_bucket', 'identity-evidence')
      .order('created_at', { ascending: true })
      .limit(MAX_FILES);
    if (Array.isArray(attachmentIds) && attachmentIds.length) query = query.in('id', attachmentIds.slice(0, MAX_FILES));
    const { data, error } = await query;
    if (error) throw new Error('attachment_lookup_failed');
    return data || [];
  }

  async function readOne(attachment) {
    const kind = fileKind(attachment.file_type, attachment.file_name);
    const base = { id: attachment.id, name: attachment.file_name, kind, readable: false, summary: null, text: '' };
    if (kind === 'media' || kind === 'other') return base;
    try {
      const text = String(await extract(attachment, kind) || '').trim();
      return { ...base, readable: Boolean(text), text };
    } catch (error) {
      return { ...base, error: error instanceof Error ? error.message : 'extract_failed' };
    }
  }

  async function understandBatch(body) {
    const conversationId = String(body.conversation_id || '');
    if (!/^[0-9a-f-]{36}$/i.test(conversationId)) return { status: 400, body: { error: 'conversation_id is required' } };
    const attachments = await listAttachments(conversationId, body.attachment_ids);
    if (!attachments.length) return { status: 200, body: { count: 0, files: [] } };
    const files = [];
    for (const attachment of attachments) files.push(await readOne(attachment));
    const publicFiles = files.map(({ text, ...rest }) => ({ ...rest, summary: text ? text.slice(0, 200).replace(/\s+/g, ' ') : null }));
    if (!files.some((file) => file.readable)) {
      return { status: 200, body: { count: files.length, files: publicFiles, synthesis: 'None of the uploaded files had readable text.', answer: null, suggested_action: null, proposed_entities: null } };
    }
    let model = null;
    try {
      const result = await gateway.chatJson('synthesis', buildMessages(String(body.question || ''), files), { maxTokens: 3500, timeoutMs: 110_000 });
      model = { parsed: parseModelJson(result.content), provider: result.provider, model: result.model };
    } catch (error) {
      return {
        status: 200,
        body: {
          count: files.length,
          files: publicFiles,
          synthesis: 'I extracted the text but no model was available to reason over it right now.',
          answer: null,
          suggested_action: null,
          proposed_entities: null,
          model_error: error instanceof Error ? error.message : 'model_unavailable',
        },
      };
    }
    const parsed = model.parsed || {};
    const summaries = new Map((Array.isArray(parsed.files) ? parsed.files : []).map((f) => [String(f && f.name || ''), String(f && f.summary || '')]));
    return {
      status: 200,
      body: {
        count: files.length,
        files: publicFiles.map((file) => ({ ...file, summary: summaries.get(file.name) || file.summary })),
        synthesis: typeof parsed.synthesis === 'string' ? parsed.synthesis : null,
        answer: typeof parsed.answer === 'string' ? parsed.answer : null,
        suggested_action: typeof parsed.suggested_action === 'string' ? parsed.suggested_action : null,
        proposed_entities: parsed.proposed_entities && typeof parsed.proposed_entities === 'object' ? parsed.proposed_entities : null,
        provider: model.provider,
        model: model.model,
      },
    };
  }

  return { understandBatch };
}

module.exports = { createDocumentReader, docxXmlToText, fileKind, parseModelJson, buildMessages };
