const assert = require('node:assert/strict');
const test = require('node:test');
const { deriveReadProgress } = require('../supabase/functions/bob-repo-search/search-logic.ts');

// This is the root-cause fix for repo_search reads arriving out of order
// across turns: nothing previously recorded the high-water line read for a
// (conversation, path, ref), so a repeated or backward read was
// indistinguishable from genuine forward progress.
test('deriveReadProgress: first read of a file has no prior progress', () => {
  const result = deriveReadProgress(0, 1, 140);
  assert.equal(result.previously_read_through, null);
  assert.equal(result.overlaps_prior_read, false);
  assert.equal(result.suggested_next_start_line, null);
  assert.equal(result.max_line_read, 140);
});

test('deriveReadProgress: forward-progressing read is not flagged', () => {
  const result = deriveReadProgress(140, 141, 240);
  assert.equal(result.overlaps_prior_read, false);
  assert.equal(result.previously_read_through, 140);
  assert.equal(result.suggested_next_start_line, 141);
  assert.equal(result.max_line_read, 240);
});

test('deriveReadProgress: re-reading an already-read window is flagged with the correct resume point', () => {
  const result = deriveReadProgress(240, 1, 140);
  assert.equal(result.overlaps_prior_read, true);
  assert.equal(result.previously_read_through, 240);
  assert.equal(result.suggested_next_start_line, 241);
  // max_line_read never regresses even when the requested window is behind it
  assert.equal(result.max_line_read, 240);
});

test('deriveReadProgress: a read starting exactly at the high-water mark is a regression, not progress', () => {
  const result = deriveReadProgress(140, 140, 200);
  assert.equal(result.overlaps_prior_read, true);
  assert.equal(result.suggested_next_start_line, 141);
});
