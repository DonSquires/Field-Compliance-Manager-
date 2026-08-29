/**
 * _shared/evidence-sanitizer.js -- Sanitize evidence references before persistence.
 *
 * Evidence must record PROOF of work (what was examined, where, when) without storing
 * CONTENT (raw file text, secret values, API responses). This prevents:
 * - Accidental secret exposure in the audit trail
 * - Unbounded storage from large file reads or API results
 * - Privacy leaks from confidential business logic
 *
 * Evidence types (from task-continuity.md):
 * - found: search result exists, path + line window + SHA
 * - not_found: clean search with no result (query + scope)
 * - could_not_verify: timeout, auth, incomplete result, or tool error
 * - malformed_query: tool input was invalid
 */

/**
 * Sanitize evidence references to remove secrets and large content.
 *
 * Input: raw result from a tool (may contain full file text, API responses, etc.)
 * Output: sanitized evidence array with proof but no secrets
 *
 * Sanitization rules:
 * - Keep file paths, line numbers, commit SHAs, artifact IDs
 * - Remove file content, API response bodies, raw results
 * - Truncate or flag capped/incomplete results
 * - Never pass raw credentials or sensitive strings
 */
function sanitizeEvidenceRefs(toolResult, toolName) {
  if (!toolResult || typeof toolResult !== 'object') {
    return [];
  }

  const refs = [];
  const meta = toolResult.meta || {};
  const reply = toolResult.reply || '';

  // Extract evidence based on tool type
  if (toolName === 'repo_search' || toolName === 'query_records') {
    // repo_search returns: { meta: { results: [...], count, was_capped }, reply: '...' }
    // Evidence: file paths, line windows, result count, capped status
    if (meta.results && Array.isArray(meta.results)) {
      const count = meta.results.length;
      refs.push({
        type: 'search_result',
        tool: toolName,
        result_count: count,
        was_capped: Boolean(meta.was_capped),
        capped_at: meta.capped_at || null,
        status: count > 0 ? 'found' : 'not_found'
      });

      // Extract just the file paths, not the content
      const paths = new Set();
      for (const result of meta.results) {
        if (result.file_path) paths.add(result.file_path);
        if (result.path) paths.add(result.path);
      }
      if (paths.size > 0) {
        refs.push({
          type: 'file_paths',
          paths: Array.from(paths),
          count: paths.size
        });
      }
    }
  }

  if (toolName === 'web_research') {
    // web_research returns structured research with URLs, not full page text
    if (meta.sources && Array.isArray(meta.sources)) {
      const urls = meta.sources
        .map(s => s.url)
        .filter(Boolean)
        .slice(0, 10); // Keep only first 10 to avoid bloat
      if (urls.length > 0) {
        refs.push({
          type: 'web_sources',
          urls,
          count: urls.length,
          total_sources: meta.sources.length
        });
      }
    }
  }

  if (toolName === 'resolve_geofence' || toolName === 'resolve_address') {
    // resolve_geofence returns boundary geometry, location name, source
    // Evidence: source (LINZ/Google/OSM), location name, not the raw boundary JSON
    if (meta.geofence) {
      const gf = meta.geofence;
      refs.push({
        type: 'geofence_resolved',
        source: gf.source || 'unknown',
        location_name: gf.name || null,
        address: gf.address || null,
        has_boundary: Boolean(gf.boundary)
      });
    }
  }

  // Generic evidence: tool outcome, timing, errors
  refs.push({
    type: 'tool_execution',
    tool: toolName,
    outcome: String(meta.outcome || 'unknown'),
    error: meta.error ? meta.error.slice(0, 200) : null, // Truncate error
    retryable: Boolean(meta.retryable),
    duration_ms: meta.duration_ms || null
  });

  // Detect if result was incomplete or truncated
  const replyLength = reply ? reply.length : 0;
  if (replyLength >= 5000) {
    // Large result, likely truncated
    refs.push({
      type: 'result_truncation',
      reply_length: replyLength,
      was_capped: Boolean(meta.was_capped),
      status: 'could_not_verify' // Incomplete results can't verify the claim
    });
  }

  return refs;
}

/**
 * Classify evidence status for resume logic.
 *
 * Returns one of: 'found', 'not_found', 'could_not_verify', 'malformed_query'
 */
function classifyEvidenceStatus(evidenceRefs, toolMeta) {
  if (!Array.isArray(evidenceRefs)) return 'could_not_verify';

  const toolExecution = evidenceRefs.find(r => r.type === 'tool_execution');
  if (!toolExecution) return 'could_not_verify';

  // Malformed query: tool rejected the input
  if (toolExecution.outcome === 'invalid_args' || toolExecution.outcome === 'malformed_query') {
    return 'malformed_query';
  }

  // Tool error or timeout
  if (toolExecution.outcome === 'error' || toolExecution.error) {
    return 'could_not_verify';
  }

  // Result truncation is incomplete verification
  const truncation = evidenceRefs.find(r => r.type === 'result_truncation');
  if (truncation && truncation.status === 'could_not_verify') {
    return 'could_not_verify';
  }

  // Search result status
  const searchResult = evidenceRefs.find(r => r.type === 'search_result');
  if (searchResult) {
    return searchResult.status || 'could_not_verify';
  }

  // Generic success
  if (toolExecution.outcome === 'ok' || toolExecution.outcome === 'completed') {
    return 'found';
  }

  return 'could_not_verify';
}

/**
 * Detect if a step should be blocked (waiting for evidence from a prior step).
 *
 * Returns blocking reason or null.
 */
function detectBlockingReason(completedSteps, currentStep, task) {
  if (!Array.isArray(completedSteps) || !currentStep) return null;

  // Example: "read-shell" step depends on "identify-entry-points" completing first
  const stepDependencies = {
    'read-shell': ['identify-entry-points'],
    'read-auth-gates': ['identify-routing-and-shells'],
    'trace-workflow': ['identify-data-api-dependencies']
  };

  const deps = stepDependencies[currentStep.step_id] || [];
  for (const dep of deps) {
    if (!completedSteps.includes(dep)) {
      return `Waiting for prior step "${dep}" to complete (evidence required)`;
    }
  }

  return null;
}

module.exports = {
  sanitizeEvidenceRefs,
  classifyEvidenceStatus,
  detectBlockingReason
};
