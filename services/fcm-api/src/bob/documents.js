'use strict';

// Batch document understanding for Bob chat (action understand_documents_batch).
// Reads every attachment in a conversation, extracts text in-house (pdftotext,
// docx XML, tesseract for images), then asks the model gateway for one grounded
// synthesis. Read-only: nothing here writes a business record.

const MAX_FILES = 8;
const MAX_TEXT_PER_FILE = 12_000;
const MAX_TEXT_TOTAL = 36_000;
const { classifyIdentityDocument, extractIdentityFieldsConsensus } = require('./identityDocument');

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
    const verified = file.structured_extraction
      ? `\nMachine-checked structured extraction (this overrides free-form OCR/model guesses for identifiers):\n${JSON.stringify(file.structured_extraction)}\n`
      : '';
    return `### File ${index + 1}: ${file.name} (${file.kind}${file.readable ? '' : ', not readable'})${verified}\n${text || '[no readable text]'}`;
  });
  return [
    {
      role: 'system',
      content: [
        'You are Bob, the assistant inside Field Compliance Manager, a New Zealand security and field-compliance platform.',
        'Read the uploaded files below and answer the user\'s request using only what the files say plus general professional knowledge.',
        'If the user asks you to draft something (for example an employment agreement), write the full draft in "answer" in Markdown, using the files as the template and source of facts, and mark any value you could not find as [TO CONFIRM].',
        'Never invent names, rates, dates or legal clauses as facts from the files. Nothing is written to the system; this is a read and a draft.',
        'IDENTIFIER RULE: when a file includes machine-checked structured extraction, state an identifier only when its status is verified_candidate and use that exact value. If its status is manual_review_required, write [TO CONFIRM] and show candidates as unverified; never choose or silently correct one.',
        'Reply with a JSON object: {"synthesis": string (2-4 sentences on what the files are and how they relate), "answer": string (the direct answer or draft), "files": [{"name": string, "summary": string}], "suggested_action": string|null, "proposed_entities": object|null}.',
      ].join(' '),
    },
    { role: 'user', content: `Request: ${question || 'Summarise these files.'}\n\n${blocks.join('\n\n')}` },
  ];
}

function structuredExtractionFor(file) {
  const variants = Array.isArray(file.variants) && file.variants.length ? file.variants : [file.text];
  const combined = variants.join('\n');
  const classification = classifyIdentityDocument(combined, 'nzta_mvr_record');
  if (classification.detected_kind !== 'nzta_mvr_record'
    || (classification.confidence !== 'high' && !/current details query results/i.test(combined))) return null;
  const consensus = extractIdentityFieldsConsensus(variants, 'nzta_mvr_record');
  return {
    document_kind: 'nzta_mvr_record',
    authority: 'provisional_source_time',
    review_required: true,
    fields: consensus.fields,
    identifier_verification: consensus.identifier_verification,
  };
}

function plateVerificationFor(structuredFiles) {
  const verifications = structuredFiles
    .filter((file) => file?.structured_extraction?.document_kind === 'nzta_mvr_record')
    .map((file) => file.structured_extraction?.identifier_verification?.plate_number)
    .filter(Boolean);
  if (!verifications.length) return null;
  const verifiedValues = [...new Set(verifications.filter((item) => item.status === 'verified_candidate' && item.value).map((item) => item.value))];
  const candidates = [...new Map(
    verifications.flatMap((item) => Array.isArray(item.candidates) ? item.candidates : []).map((item) => [item.value, item]),
  ).values()];
  if (verifiedValues.length === 1 && verifications.every((item) => item.status === 'verified_candidate' && item.value === verifiedValues[0])) {
    return { status: 'verified_candidate', value: verifiedValues[0], candidates };
  }
  return { status: 'manual_review_required', value: null, candidates };
}

function guardPlateLines(text, structuredFiles) {
  const source = String(text || '');
  const verification = plateVerificationFor(structuredFiles);
  if (!verification) return source;
  const replacement = verification.status === 'verified_candidate' && verification.value
    ? verification.value
    : `[TO CONFIRM${Array.isArray(verification.candidates) && verification.candidates.length ? `: OCR candidates ${verification.candidates.map((candidate) => candidate.value).join(', ')}` : ''}]`;
  let guarded = source;
  for (const candidate of Array.isArray(verification.candidates) ? verification.candidates : []) {
    const value = String(candidate?.value || '');
    if (!value || value === verification.value) continue;
    guarded = guarded.replace(new RegExp(`\\b${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), verification.value || '[TO CONFIRM]');
  }
  return guarded.replace(
    /((?:\*\*)?(?:plate(?: number)?|registration plate|rego)(?:\*\*)?\s*[:#-](?:\*\*)?)(\s*)([A-Z0-9 -]{2,12})(\*\*)?/gi,
    (_match, prefix, spacing, _value, suffix) => `${prefix}${spacing}${replacement}${suffix || ''}`,
  );
}

function guardProposedEntities(value, structuredFiles) {
  if (!value || typeof value !== 'object') return value;
  const copy = JSON.parse(JSON.stringify(value));
  const verification = plateVerificationFor(structuredFiles);
  if (!verification) return copy;
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    for (const [key, child] of Object.entries(node)) {
      if (['plate', 'plate_number', 'rego', 'registration'].includes(key.toLowerCase())) {
        if (verification.status === 'verified_candidate' && verification.value) node[key] = verification.value;
        else delete node[key];
      } else visit(child);
    }
  };
  visit(copy);
  return copy;
}

function createDocumentReader({ supabase, gateway, extract }) {
  async function listAttachments(conversationId, attachmentIds) {
    let query = supabase.from('bob_attachments')
      .select('id,organization_id,conversation_id,file_name,file_type,file_size_bytes,storage_bucket,storage_path,extraction_payload,created_at')
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
    const base = { id: attachment.id, name: attachment.file_name, kind, readable: false, summary: null, text: '', existing_payload: attachment.extraction_payload };
    if (kind === 'media' || kind === 'other') return base;
    try {
      const extraction = await extract(attachment, kind);
      const text = String(typeof extraction === 'string' ? extraction : extraction?.text || '').trim();
      const variants = typeof extraction === 'object' && Array.isArray(extraction?.variants)
        ? extraction.variants.map((value) => String(value || '').trim()).filter(Boolean)
        : [text].filter(Boolean);
      const file = { ...base, readable: Boolean(text), text, variants, provider: typeof extraction === 'object' ? extraction?.provider ?? null : null };
      return { ...file, structured_extraction: kind === 'image' ? structuredExtractionFor(file) : null };
    } catch (error) {
      return { ...base, error: error instanceof Error ? error.message : 'extract_failed' };
    }
  }

  async function persistExtractionStates(conversationId, files) {
    const errors = [];
    for (const file of files) {
      if (file.kind === 'media' || file.kind === 'other') continue;
      const plate = file.structured_extraction?.identifier_verification?.plate_number;
      const processingState = file.error ? 'failed' : file.structured_extraction?.review_required ? 'manual_review_required' : file.readable ? 'extracted' : 'failed';
      const summary = file.structured_extraction
        ? plate?.status === 'verified_candidate'
          ? `NZTA source detected. Plate candidate ${plate.value} has OCR consensus; administrator source review is still required.`
          : `NZTA source detected. Plate could not be verified from OCR${plate?.candidates?.length ? `; candidates: ${plate.candidates.map((candidate) => candidate.value).join(', ')}` : ''}.`
        : file.readable ? file.text.slice(0, 240).replace(/\s+/g, ' ') : file.error || 'No readable text was extracted.';
      const { error } = await supabase.from('bob_attachments').update({
        processing_state: processingState,
        extraction_summary: summary,
        extraction_payload: {
          ...(file.existing_payload && typeof file.existing_payload === 'object' ? file.existing_payload : {}),
          provider: file.provider ?? null,
          structured_extraction: file.structured_extraction ?? null,
        },
        confidence: null,
      }).eq('id', file.id).eq('conversation_id', conversationId);
      if (error) errors.push({ id: file.id, error: error.message });
    }
    return errors;
  }

  async function understandBatch(body) {
    const conversationId = String(body.conversation_id || '');
    if (!/^[0-9a-f-]{36}$/i.test(conversationId)) return { status: 400, body: { error: 'conversation_id is required' } };
    const attachments = await listAttachments(conversationId, body.attachment_ids);
    if (!attachments.length) return { status: 200, body: { count: 0, files: [] } };
    const files = [];
    for (const attachment of attachments) files.push(await readOne(attachment));
    const persistenceErrors = await persistExtractionStates(conversationId, files);
    const publicFiles = files.map(({ text, variants, existing_payload, ...rest }) => ({ ...rest, summary: text ? text.slice(0, 200).replace(/\s+/g, ' ') : null }));
    if (!files.some((file) => file.readable)) {
      return { status: 200, body: { count: files.length, files: publicFiles, synthesis: 'None of the uploaded files had readable text.', answer: null, suggested_action: null, proposed_entities: null, persistence_errors: persistenceErrors } };
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
          persistence_errors: persistenceErrors,
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
        synthesis: typeof parsed.synthesis === 'string' ? guardPlateLines(parsed.synthesis, files) : null,
        answer: typeof parsed.answer === 'string' ? guardPlateLines(parsed.answer, files) : null,
        suggested_action: typeof parsed.suggested_action === 'string' ? parsed.suggested_action : null,
        proposed_entities: parsed.proposed_entities && typeof parsed.proposed_entities === 'object' ? guardProposedEntities(parsed.proposed_entities, files) : null,
        provider: model.provider,
        model: model.model,
        persistence_errors: persistenceErrors,
      },
    };
  }

  return { understandBatch };
}

module.exports = {
  buildMessages,
  createDocumentReader,
  docxXmlToText,
  fileKind,
  guardPlateLines,
  guardProposedEntities,
  parseModelJson,
  plateVerificationFor,
  structuredExtractionFor,
};
