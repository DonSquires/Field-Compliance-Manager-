// ── bob-repo-search — PURE truth-state logic (Bob's eyes) ────────────────────
// Extracted from index.ts so the criteria-1/3/5 logic is unit-testable WITHOUT
// mocking the GitLab fetch. Only PURE, I/O-free pieces live here; the search/read
// fetch stays in index.ts. Mirrors the constitutional-lane.ts extraction pattern.
//
// WHY these matter: GitLab BASIC blob search has no boolean/OR support, so a
// pipe-delimited query returned a false zero indistinguishable from real absence
// -- the truth-state canon Rule 2 violation (empty must say which) living inside
// Bob's own instrument. splitSearchTerms fixes the OR case; deriveSearchStatus
// guarantees zero-hits and could-not-see are DIFFERENT faces.
// Split a `|`-delimited OR query into trimmed, non-empty terms. A query with no
// `|` yields a single-element array (unchanged single-term behaviour).
export function splitSearchTerms(query) {
  const q = String(query ?? '').trim();
  if (!q) return [];
  if (!q.includes('|')) return [
    q
  ];
  return q.split('|').map((t)=>t.trim()).filter((t)=>t.length > 0);
}
// Detect a compound multi-instruction query that should NOT be passed to the
// grep matcher as a single literal term. Returns a human-readable reason string
// when the query looks compound, or null when it looks like a valid search term.
//
// A query is compound when it contains:
//   - Semicolons (`;`) separating multiple instructions
//   - Multiple newlines (natural language paragraph / instruction list)
//   - Multiple distinct quoted strings (e.g. "foo" and "bar" in one query)
//   - Excessive length (> 200 chars) — a grep term this long is never intentional
//
// The `|` delimiter is INTENTIONAL (user-controlled OR query) and is NOT flagged.
// This guard exists to catch the case where Bob passes a whole instruction block
// as the query arg, producing a false not_found (the #327 failure mode).
export function detectCompoundQuery(query) {
  const q = String(query ?? '').trim();
  if (!q) return null;
  // Multiple semicolons = instruction list
  if ((q.match(/;/g) ?? []).length >= 2) {
    return 'Query contains multiple semicolons — looks like a compound instruction list, not a single search term. Issue one search term per call, or use | to search multiple terms in one call (e.g. "term1|term2").';
  }
  // Multiple newlines = paragraph / multi-line instruction
  if ((q.match(/\n/g) ?? []).length >= 2) {
    return 'Query spans multiple lines — looks like a compound instruction, not a single search term. Issue one search term per call.';
  }
  // Multiple distinct quoted strings (two or more "..." or \'...\' groups)
  const quotedGroups = q.match(/"[^"]+"|'[^']+'/g) ?? [];
  if (quotedGroups.length >= 2) {
    return `Query contains ${quotedGroups.length} quoted strings — looks like multiple search targets. Issue one search term per call, or use | to OR them (e.g. "${quotedGroups[0]}|${quotedGroups[1]}").`;
  }
  // Excessive length — no valid grep term is this long
  if (q.length > 200) {
    return `Query is ${q.length} characters — too long to be a valid search term (max 200). Break it into discrete terms and issue one call per term.`;
  }
  return null;
}
// Derive the distinguished-empty status + human note (Bob criteria 1 + 5).
//   found            -> at least one hit (note only if partial: some term failed)
//   could_not_verify -> zero hits AND at least one term's search call failed
//                       (partial/total blindness -- NOT evidence of absence)
//   not_found        -> zero hits AND every term searched cleanly
// The key invariant: a search that COULD NOT RUN never reports 'not_found'.
export function deriveSearchStatus(input) {
  const { resultCount, couldNotVerify, failedTerms, wasOrQuery, termCount } = input;
  if (resultCount > 0) {
    return couldNotVerify ? {
      status: 'found',
      note: `Partial: ${failedTerms.length} term(s) could not be searched (${failedTerms.join(', ')}); results may be incomplete.`
    } : {
      status: 'found'
    };
  }
  if (couldNotVerify) {
    return {
      status: 'could_not_verify',
      note: `Could not verify: search failed for term(s) [${failedTerms.join(', ')}]. This is NOT evidence of absence.`
    };
  }
  return {
    status: 'not_found',
    note: wasOrQuery ? `No matches for any of ${termCount} terms; each was searched separately (GitLab basic search has no OR operator).` : undefined
  };
}
// PER-TERM status decision (Jim Attack A). Extracted from the impure fetch loop
// so the per-term map -- the headline truth-state fix -- is provable at the pure
// layer, not just asserted inline. failed (search call errored) wins over any
// hit count: a term we could not search is could_not_verify, never not_found.
export function deriveTermStatus(input) {
  if (input.failed) return 'could_not_verify';
  return input.hitCount > 0 ? 'found' : 'not_found';
}
// PURE read-window math (Bob Blocker 1: pagination boundaries). Given the
// ALREADY-REDACTED text (redaction runs line-wise on the full text BEFORE this,
// so no slice can split a redaction), compute the window at `rawOffset` and the
// distinguished read_state. Kept pure so exact-page / page+1 / final-page /
// offset-past-EOF are all assertable without a GitLab fetch.
export function computeReadWindow(redacted, rawOffset, window = 20000) {
  const totalLength = redacted.length;
  // Non-finite (NaN from a junk string) and negatives clamp to 0; over-length
  // clamps to totalLength (so offset-past-EOF is a real, reportable state).
  const offset = Number.isFinite(rawOffset) ? Math.min(Math.max(Math.trunc(rawOffset), 0), totalLength) : 0;
  const content = redacted.slice(offset, offset + window);
  const endOfWindow = offset + content.length;
  const hasMore = endOfWindow < totalLength;
  let readState;
  let readNote;
  if (totalLength === 0) {
    readState = 'empty_file';
    readNote = 'File exists but is empty (0 bytes).';
  } else if (offset >= totalLength) {
    readState = 'offset_past_end';
    readNote = `Offset ${offset} is at/past end of a ${totalLength}-char file; nothing to return here (this is NOT an empty file).`;
  } else {
    readState = 'window';
  }
  return {
    offset,
    content,
    returned: content.length,
    hasMore,
    nextOffset: hasMore ? endOfWindow : null,
    totalLength,
    readState,
    readNote
  };
}

// Exact line-addressed reads for search results that return startline. Lines
// are one-based for callers; the returned range is inclusive.
export function computeLineWindow(redacted, rawStartLine, rawEndLine, maxLines = 240) {
  const lines = redacted.split('\n');
  const totalLines = redacted === '' ? 0 : lines.length;
  const startLine = Number.isFinite(rawStartLine) ? Math.max(1, Math.trunc(rawStartLine)) : 1;
  const requestedEnd = Number.isFinite(rawEndLine) ? Math.max(startLine, Math.trunc(rawEndLine)) : startLine + maxLines - 1;
  const endLine = Math.min(requestedEnd, startLine + maxLines - 1);
  const content = startLine > totalLines ? '' : lines.slice(startLine - 1, endLine).join('\n');
  const actualEndLine = content === '' ? startLine - 1 : startLine + content.split('\n').length - 1;
  return {
    content,
    startLine,
    endLine: actualEndLine,
    requestedEndLine: requestedEnd,
    totalLines,
    hasMore: actualEndLine < totalLines,
    nextStartLine: actualEndLine < totalLines ? actualEndLine + 1 : null,
    readState: totalLines === 0 ? 'empty_file' : startLine > totalLines ? 'line_past_end' : 'line_window'
  };
}

// ── Read-progress / out-of-order detection ───────────────────────────────────
// Nothing in computeLineWindow (or the caller) tracks what has ALREADY been
// read for a given (conversation, path, ref) across turns. Without this, a
// caller re-requesting an already-read window, skipping ahead, or jumping
// backward is indistinguishable from genuine forward progress -- the exact
// failure observed live: repo_search reads for the same file arriving in
// scrambled, overlapping order across turns. This is PURE: given the
// previously-recorded high-water mark (max line number ever returned for this
// file in this conversation) and the window just computed, derive whether
// this read overlaps/regresses and what the caller should read next.
export function deriveReadProgress(previousMaxLineRead, startLine, actualEndLine) {
  const prevMax = Number.isFinite(previousMaxLineRead) ? Math.max(0, Math.trunc(previousMaxLineRead)) : 0;
  const isRegression = prevMax > 0 && startLine <= prevMax;
  const newMax = Math.max(prevMax, actualEndLine);
  return {
    previously_read_through: prevMax > 0 ? prevMax : null,
    overlaps_prior_read: isRegression,
    suggested_next_start_line: prevMax > 0 ? prevMax + 1 : null,
    max_line_read: newMax
  };
}

