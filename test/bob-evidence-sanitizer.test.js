const assert = require('node:assert/strict');
const test = require('node:test');
const {
  sanitizeEvidenceRefs,
  classifyEvidenceStatus,
  detectBlockingReason
} = require('../supabase/functions/_shared/evidence-sanitizer.js');

test('sanitizeEvidenceRefs strips file content but keeps paths', () => {
  const toolResult = {
    reply: 'Found 3 files matching the search.',
    meta: {
      outcome: 'ok',
      results: [
        { file_path: 'src/handlers/auth.ts', content: 'secret_password_here_12345' },
        { file_path: 'src/pages/login.tsx', content: 'api_key_abc123xyz' }
      ],
      count: 2,
      was_capped: false
    }
  };

  const evidence = sanitizeEvidenceRefs(toolResult, 'repo_search');

  assert.ok(Array.isArray(evidence));
  assert.ok(evidence.length > 0);

  // Find file paths evidence
  const pathsEvidence = evidence.find(e => e.type === 'file_paths');
  assert.ok(pathsEvidence);
  assert.deepEqual(pathsEvidence.paths, ['src/handlers/auth.ts', 'src/pages/login.tsx']);

  // Verify NO content is in evidence
  const evidenceString = JSON.stringify(evidence);
  assert.ok(!evidenceString.includes('secret_password_here_12345'));
  assert.ok(!evidenceString.includes('api_key_abc123xyz'));
});

test('sanitizeEvidenceRefs marks capped searches', () => {
  const toolResult = {
    reply: 'Search returned 1000+ results (capped at 100).',
    meta: {
      outcome: 'ok',
      results: Array(100).fill({ file_path: 'file.ts' }),
      count: 100,
      was_capped: true,
      capped_at: 100
    }
  };

  const evidence = sanitizeEvidenceRefs(toolResult, 'repo_search');
  const searchResult = evidence.find(e => e.type === 'search_result');

  assert.ok(searchResult);
  assert.equal(searchResult.was_capped, true);
  assert.equal(searchResult.capped_at, 100);
});

test('classifyEvidenceStatus returns found for successful search', () => {
  const evidence = [
    { type: 'search_result', result_count: 3, status: 'found' },
    { type: 'file_paths', paths: ['file1.ts', 'file2.ts'] },
    { type: 'tool_execution', outcome: 'ok', error: null }
  ];

  const status = classifyEvidenceStatus(evidence);
  assert.equal(status, 'found');
});

test('classifyEvidenceStatus returns not_found for empty result', () => {
  const evidence = [
    { type: 'search_result', result_count: 0, status: 'not_found' },
    { type: 'tool_execution', outcome: 'ok', error: null }
  ];

  const status = classifyEvidenceStatus(evidence);
  assert.equal(status, 'not_found');
});

test('classifyEvidenceStatus returns could_not_verify for errors', () => {
  const evidence = [
    { type: 'tool_execution', outcome: 'error', error: 'Timeout' }
  ];

  const status = classifyEvidenceStatus(evidence);
  assert.equal(status, 'could_not_verify');
});

test('classifyEvidenceStatus returns malformed_query for invalid input', () => {
  const evidence = [
    { type: 'tool_execution', outcome: 'invalid_args', error: null }
  ];

  const status = classifyEvidenceStatus(evidence);
  assert.equal(status, 'malformed_query');
});

test('detectBlockingReason finds unmet dependencies', () => {
  const completedSteps = ['identify-entry-points'];
  const currentStep = { step_id: 'read-shell' };

  const reason = detectBlockingReason(completedSteps, currentStep);
  assert.equal(reason, null); // identify-entry-points IS completed, so no block
});

test('detectBlockingReason blocks when dependency missing', () => {
  const completedSteps = [];
  const currentStep = { step_id: 'read-shell' };

  const reason = detectBlockingReason(completedSteps, currentStep);
  assert.ok(reason);
  assert.ok(reason.includes('identify-entry-points'));
  assert.ok(reason.includes('Waiting for prior step'));
});
