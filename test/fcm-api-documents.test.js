'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDocumentReader, docxXmlToText, fileKind } = require('../services/fcm-api/src/bob/documents');

function fakeSupabase(rows) {
  const query = {
    select() { return query; }, eq() { return query; }, neq() { return query; }, order() { return query; },
    in() { return query; }, update() { return query; },
    limit() { return Promise.resolve({ data: rows, error: null }); },
  };
  return { from: () => query };
}

test('docx XML becomes paragraph text', () => {
  assert.equal(docxXmlToText('<w:p><w:r><w:t>Casual &amp; Guard</w:t></w:r></w:p><w:p><w:t>Pay</w:t></w:p>'), 'Casual & Guard\nPay');
  assert.equal(fileKind('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'a.docx'), 'docx');
  assert.equal(fileKind('application/pdf', 'x'), 'pdf');
});

test('understandBatch reads files and returns the model draft', async () => {
  const rows = [{ id: 'a1', file_name: 'Agreement.docx', file_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }];
  let seen = null;
  const gateway = { chatJson: async (role, messages) => { seen = { role, messages }; return { content: JSON.stringify({ synthesis: 'An employment agreement.', answer: '# Draft', files: [{ name: 'Agreement.docx', summary: 'Template' }] }), provider: 'gpu_workstation', model: 'm' }; } };
  const reader = createDocumentReader({ supabase: fakeSupabase(rows), gateway, extract: async () => 'Employment agreement text' });
  const result = await reader.understandBatch({ conversation_id: '051783a6-0000-4000-8000-000000000000', question: 'draft a casual agreement' });
  assert.equal(result.status, 200);
  assert.equal(result.body.count, 1);
  assert.equal(result.body.answer, '# Draft');
  assert.equal(result.body.files[0].summary, 'Template');
  assert.equal(result.body.files[0].text, undefined);
  assert.match(seen.messages[1].content, /Employment agreement text/);
});

test('understandBatch degrades without a model instead of failing', async () => {
  const rows = [{ id: 'a1', file_name: 'r.pdf', file_type: 'application/pdf' }];
  const gateway = { chatJson: async () => { throw new Error('no model provider available for role synthesis'); } };
  const reader = createDocumentReader({ supabase: fakeSupabase(rows), gateway, extract: async () => 'rate card' });
  const result = await reader.understandBatch({ conversation_id: '051783a6-0000-4000-8000-000000000000' });
  assert.equal(result.status, 200);
  assert.equal(result.body.count, 1);
  assert.match(result.body.model_error, /no model provider/);
});
