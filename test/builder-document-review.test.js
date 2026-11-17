'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { buildDocumentReviewItems, evaluateAutomatedDocumentReview, processDocumentReviewItems, reviewWithBobAndOracle, verifyDocumentSourceBytes, sha256 } = require('../builder-document-review');

function reviewer(provider, model, overrides = {}) {
  return {
    provider,
    model,
    content: JSON.stringify({
      decision: 'approve',
      reason: 'Every proposed value is supported by the source.',
      confidence: 0.99,
      source_claims: [{ field: 'title', value: 'Safety Plan', quote: 'Title: Safety Plan', confidence: 0.99 }],
      unsupported_claims: [],
      unresolved_fields: [],
      privacy: {
        privacy_class: 'tenant_sensitive', contains_pii: false,
        contains_operational_security: false, contains_financial_data: false, contains_legal_privilege: false,
      },
      ...overrides,
    }),
  };
}

function evaluate(overrides = {}) {
  const sourceText = 'Title: Safety Plan';
  const hash = sha256(sourceText);
  return evaluateAutomatedDocumentReview({
    subjectKind: 'promotion', sourceText, expectedSourceHash: hash, currentSourceHash: hash,
    expectedFields: { title: 'Safety Plan' },
    bob: reviewer('gpu_workstation', 'bob-private'),
    oracle: reviewer('ollama', 'oracle-private'),
    ...overrides,
  });
}

test('only two distinct private reviewers with exact source citations can approve', () => {
  const result = evaluate();
  assert.equal(result.disposition, 'approved', JSON.stringify(result));
  assert.doesNotMatch(result.reason, /Field coverage|Title:/);
  assert.equal(result.global_promotion_eligible, false, 'tenant-sensitive material cannot be globally promoted');
  assert.deepEqual(result.reviewers.map(({ role }) => role), ['bob', 'oracle']);
});

test('missing OCR and changed source hashes open the exact review fallback, never approval', () => {
  assert.equal(evaluate({ ocrRequired: true }).disposition, 'quarantined');
  assert.equal(evaluate({ ocrRequired: true }).open_review, true);
  assert.equal(evaluate({ currentSourceHash: '0'.repeat(64) }).disposition, 'blocked');
});

test('unconfirmed draft fields stay unapproved and route to Document Studio', () => {
  const result = evaluate({ subjectKind: 'draft', unconfirmedFields: 2 });
  assert.equal(result.disposition, 'blocked');
  assert.equal(result.open_review, true);
});

test('model disagreement, same-model review, external models and unsupported claims fail closed', () => {
  assert.equal(evaluate({ oracle: reviewer('ollama', 'oracle-private', { decision: 'reject' }) }).disposition, 'blocked');
  assert.equal(evaluate({ oracle: reviewer('gpu_workstation', 'bob-private') }).disposition, 'blocked');
  assert.equal(evaluate({ oracle: reviewer('openai', 'external') }).disposition, 'blocked');
  assert.equal(evaluate({ bob: reviewer('gpu_workstation', 'bob-private', { source_claims: [{ field: 'title', value: 'Safety Plan', quote: 'not in source', confidence: 0.99 }] }) }).disposition, 'blocked');
  assert.equal(evaluate({ expectedFields: { title: 'Invented Plan' }, bob: reviewer('gpu_workstation', 'bob-private', { source_claims: [{ field: 'title', value: 'Invented Plan', quote: 'Title: Safety Plan', confidence: 0.99 }] }) }).disposition, 'blocked');
});

test('credential-shaped payloads never reach either reviewer', async () => {
  const result = await reviewWithBobAndOracle({
    item: { sourceText: 'Title: Safety Plan', proposedPayload: { api_token: 'synthetic-credential-sentinel' }, sourceFileHash: 'a'.repeat(64), sourceTextHash: sha256('Title: Safety Plan'), sourceVerification: { method: 'utf8_bytes_v1', file_sha256: 'a'.repeat(64), text_sha256: sha256('Title: Safety Plan') } },
    health: {}, config: {}, invoke: async () => assert.fail('credential content must not reach models'),
  });
  assert.equal(result.disposition, 'blocked');
  assert.match(result.reason, /Credential-like/);
});

test('privacy risk flags are combined restrictively and prevent global promotion', () => {
  const publicReview = { ...JSON.parse(reviewer('gpu_workstation', 'bob-private').content), privacy: {
    privacy_class: 'public', contains_pii: false, contains_operational_security: false, contains_financial_data: false, contains_legal_privilege: false,
  } };
  const oracleReview = { ...publicReview, privacy: { ...publicReview.privacy, contains_legal_privilege: true, privacy_class: 'restricted' } };
  const result = evaluate({
    bob: reviewer('gpu_workstation', 'bob-private', publicReview),
    oracle: reviewer('ollama', 'oracle-private', oracleReview),
  });
  assert.equal(result.disposition, 'approved', JSON.stringify(result));
  assert.equal(result.privacy.privacy_class, 'restricted');
  assert.equal(result.privacy.contains_legal_privilege, true);
  assert.equal(result.global_promotion_eligible, false);
});

test('Bob and Oracle use distinct local models and Oracle sees the original source and Bob review', async () => {
  const sourceText = 'Title: Safety Plan';
  const sourceTextHash = sha256(sourceText);
  const calls = [];
  const content = reviewer('gpu_workstation', 'bob-private').content;
  const result = await reviewWithBobAndOracle({
    item: { subjectKind: 'promotion', documentVersionId: 'version-1', sourceText, sourceTextHash, sourceFileHash: 'a'.repeat(64), sourceVerification: { method: 'utf8_bytes_v1', file_sha256: 'a'.repeat(64), text_sha256: sourceTextHash }, expectedFields: { title: 'Safety Plan' } },
    health: {
      gpu_workstation: { configured: true, healthy: true, models: ['bob-private'] },
      ollama: { configured: true, healthy: true, models: ['oracle-private'] },
    },
    config: {},
    invoke: async ({ input }) => {
      calls.push(input);
      return { status: 200, body: { provider: input.provider, model: input.model, content } };
    },
  });
  assert.equal(result.disposition, 'approved', JSON.stringify(result));
  assert.deepEqual(calls.map((call) => call.provider), ['gpu_workstation', 'ollama']);
  assert.ok(calls.every((call) => call.builder_mode === 'document_reviewer'));
  assert.match(calls[1].user_prompt, /"bob_review"/);
  assert.match(calls[1].user_prompt, /Title: Safety Plan/);
});

test('queue runner records approved proposals and retries application without repeating review', async () => {
  const sourceText = 'Title: Safety Plan';
  const item = { id: 'proposal-1', subjectKind: 'promotion', documentVersionId: 'version-1', sourceText, sourceTextHash: sha256(sourceText), sourceFileHash: 'a'.repeat(64), sourceVerification: { method: 'utf8_bytes_v1', file_sha256: 'a'.repeat(64), text_sha256: sha256(sourceText) }, expectedFields: { title: 'Safety Plan' } };
  const content = reviewer('gpu_workstation', 'bob-private').content;
  const health = {
    gpu_workstation: { configured: true, healthy: true, models: ['bob-private'] },
    ollama: { configured: true, healthy: true, models: ['oracle-private'] },
  };
  const calls = [];
  const result = await processDocumentReviewItems({
    items: [item], health, config: {},
    invoke: async ({ input }) => ({ status: 200, body: { provider: input.provider, model: input.model, content } }),
    claim: async () => ({ claimed: true, receipt_id: 'receipt-1' }),
    finish: async (_item, receipt, decision) => { calls.push(['finish', receipt, decision.decision]); return { status: decision.decision }; },
    applyProposal: async (_item, receipt) => { calls.push(['apply', receipt]); return 'applied'; },
  });
  assert.deepEqual(result, [{ id: 'proposal-1', outcome: 'applied', reason_code: 'source_verified_by_bob_oracle' }]);
  assert.deepEqual(calls, [['finish', 'receipt-1', 'approved'], ['apply', 'receipt-1']]);

  const retry = await processDocumentReviewItems({
    items: [item], health, config: {}, invoke: async () => { assert.fail('completed receipt must not re-run the models'); },
    claim: async () => ({ claimed: false, state: 'approved', receipt_id: 'receipt-1' }),
    finish: async () => { assert.fail('completed receipt must not be rewritten'); },
    applyProposal: async (_item, receipt) => { assert.equal(receipt, 'receipt-1'); return 'applied'; },
  });
  assert.deepEqual(retry, [{ id: 'proposal-1', outcome: 'applied', reason_code: 'source_verified_by_bob_oracle' }]);
});

test('queue runner notifies with the exact item when OCR or private review is blocked', async () => {
  const item = { id: 'source-1', subjectKind: 'classification', documentVersionId: 'version-2', sourceText: '', sourceTextHash: '', sourceFileHash: 'b'.repeat(64), ocrRequired: true };
  const notifications = [];
  const outcomes = await processDocumentReviewItems({
    items: [item], health: {}, config: {}, invoke: async () => { assert.fail('OCR-blocked source must not reach a model'); },
    claim: async () => ({ claimed: true, receipt_id: 'receipt-2' }),
    finish: async (_item, _receipt, decision) => ({ status: decision.decision }),
    notify: async (failedItem, details) => notifications.push([failedItem.id, details.reason_code]),
  });
  assert.deepEqual(outcomes, [{ id: 'source-1', outcome: 'quarantined', reason_code: 'ocr_incomplete' }]);
  assert.deepEqual(notifications, [['source-1', 'ocr_incomplete']]);
});

test('conversation-only drafts without frozen evidence are blocked and routed without model review', async () => {
  const item = {
    id: 'draft-1', subjectKind: 'draft', documentVersionId: 'version-draft',
    sourceText: '', sourceTextHash: sha256('Draft body'), sourceFileHash: 'f'.repeat(64),
    sourceBlockReason: 'Draft is conversation-only and has no independently verifiable source evidence.',
  };
  let savedReview;
  const notifications = [];
  const outcomes = await processDocumentReviewItems({
    items: [item], health: {}, config: {}, invoke: async () => { assert.fail('conversation-only draft must not be sent as its own evidence'); },
    claim: async () => ({ claimed: true, receipt_id: 'receipt-draft' }),
    finish: async (_item, _receipt, review) => { savedReview = review; return { status: review.decision }; },
    notify: async (failedItem, details) => notifications.push([failedItem.id, details.reason_code]),
  });
  assert.equal(savedReview.decision, 'blocked');
  assert.match(savedReview.reason, /no independently verifiable source evidence/);
  assert.deepEqual(outcomes, [{ id: 'draft-1', outcome: 'blocked', reason_code: 'source_provenance_missing' }]);
  assert.deepEqual(notifications, [['draft-1', 'source_provenance_missing']]);
});

test('byte verification rejects modified extraction, wrong checksums, and unsupported formats', () => {
  const bytes = Buffer.from('Title: Safety Plan');
  const item = { fileName: 'source.txt', sourceText: bytes.toString(), sourceFileHash: sha256(bytes.toString()) };
  assert.equal(verifyDocumentSourceBytes(item, bytes).sourceVerification.method, 'utf8_bytes_v1');
  assert.match(verifyDocumentSourceBytes({ ...item, sourceText: 'Invented Plan' }, bytes).sourceBlockReason, /does not match/);
  assert.match(verifyDocumentSourceBytes({ ...item, sourceFileHash: '0'.repeat(64) }, bytes).sourceBlockReason, /checksum/);
  assert.match(verifyDocumentSourceBytes({ ...item, fileName: 'source.pdf' }, bytes).sourceBlockReason, /no independent/);
});

test('review queue selects only pending tenant-owned draft/classification/proposal work and keeps exact targets', () => {
  const documents = [{
    id: 'doc-1', organization_id: 'org-1', original_filename: 'source.pdf', sha256: 'a'.repeat(64),
    current_scope: 'tenant', document_versions: [{ id: 'version-1', extracted_text: 'Title: Safety Plan', ocr_required: false, created_at: '2026-01-01', metadata_json: {}, document_classifications: [] }],
  }, {
    id: 'doc-2', organization_id: 'org-1', original_filename: 'locked.pdf', sha256: 'b'.repeat(64),
    current_scope: 'conversation_only', document_versions: [{ id: 'version-2', extracted_text: 'Draft [TO CONFIRM]', ocr_required: false, created_at: '2026-01-02', metadata_json: { authoring_status: 'needs_review', authored_text: 'Draft [TO CONFIRM]' }, document_classifications: [] }],
  }, {
    id: 'doc-3', organization_id: 'org-1', original_filename: 'done.pdf', sha256: 'c'.repeat(64),
    current_scope: 'tenant', document_versions: [{ id: 'version-3', extracted_text: 'Title: done', ocr_required: false, created_at: '2026-01-03', metadata_json: { automated_review: { decision: 'approved' } }, document_classifications: [{ classifier_source: 'rule_engine', created_at: '2026-01-03' }] }],
  }];
  const proposals = [{ id: 'proposal-1', organization_id: 'org-1', document_version_id: 'version-1', target_type: 'investigation_link', status: 'proposed', proposed_payload: { title: 'Safety Plan', investigation_id: 'case-1' }, document_version: { id: 'version-1', extracted_text: 'Title: Safety Plan', documents: { id: 'doc-1', original_filename: 'source.pdf', sha256: 'a'.repeat(64) } } }];
  const items = buildDocumentReviewItems({ documents, proposals });
  assert.deepEqual(items.map(item => [item.subjectKind, item.id]), [
    ['draft', 'doc-2:version-2'],
    ['promotion', 'proposal-1'],
    ['classification', 'doc-1:version-1'],
  ]);
  assert.deepEqual(items[1].expectedFields, { title: 'Safety Plan' });
  assert.match(items[0].sourceBlockReason, /conversation-only/);
  assert.equal(items[2].targetScope, 'tenant_reference');
});