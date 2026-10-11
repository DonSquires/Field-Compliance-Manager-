const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const draft = fs.readFileSync('supabase/functions/bob-agentic-document-draft/index.ts', 'utf8');
const chat = fs.readFileSync('supabase/functions/onspace-ai-chat/index.ts', 'utf8');
const caddie = fs.readFileSync('supabase/functions/onspace-ai-chat/caddie.ts', 'utf8');

test('R&M RFQ drafts are bound to the latest completed approved local-source inventory', () => {
  assert.match(draft, /sourceType === 'rm_rfq'/);
  assert.match(draft, /source_kind', 'local_folder'/);
  assert.match(draft, /approval_status', 'approved'/);
  assert.match(draft, /eq\('status', 'completed'\)/);
  assert.match(draft, /document_source_manifest_entries/);
  assert.match(draft, /manifestEntryIds/);
  assert.match(draft, /sha256: entry\.sha256/);
  assert.match(draft, /source_type: 'document_source_manifest_entry'/);
});

test('R&M RFQ drafts remain human-review documents with explicit unresolved fields', () => {
  assert.match(draft, /HUMAN INPUT REQUIRED/);
  assert.match(draft, /submit_bob_document_for_review/);
  assert.match(draft, /documentType = 'rfq_response'/);
});

test('Bob exposes the RFQ source mode without widening custom draft authority', () => {
  assert.match(caddie, /sourceType "rm_rfq"/);
  assert.match(chat, /sourceType = String\(args\.source_type/);
  assert.match(chat, /sourceType !== 'rm_rfq' && !authoredText/);
  assert.match(chat, /manifestEntryIds/);
});
