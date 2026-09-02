/**
 * ESM/Edge-runtime version of evidence-sanitizer.js.
 * Keep behavior aligned with the CommonJS file used by Node tests.
 */

export function sanitizeEvidenceRefs(toolResult: any, toolName: string) {
  if (!toolResult || typeof toolResult !== 'object') return [];

  const refs: any[] = [];
  const meta = toolResult.meta || {};
  const reply = toolResult.reply || '';

  if (toolName === 'repo_search' || toolName === 'query_records') {
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

      const paths = new Set<string>();
      for (const result of meta.results) {
        if (result.file_path) paths.add(result.file_path);
        if (result.path) paths.add(result.path);
      }
      if (paths.size > 0) {
        refs.push({ type: 'file_paths', paths: Array.from(paths), count: paths.size });
      }
    }
  }

  if (toolName === 'web_research') {
    if (meta.sources && Array.isArray(meta.sources)) {
      const urls = meta.sources.map((source: any) => source.url).filter(Boolean).slice(0, 10);
      if (urls.length > 0) {
        refs.push({ type: 'web_sources', urls, count: urls.length, total_sources: meta.sources.length });
      }
    }
  }

  if (toolName === 'resolve_geofence' || toolName === 'resolve_address') {
    if (meta.geofence) {
      const geofence = meta.geofence;
      refs.push({
        type: 'geofence_resolved',
        source: geofence.source || 'unknown',
        location_name: geofence.name || null,
        address: geofence.address || null,
        has_boundary: Boolean(geofence.boundary)
      });
    }
  }

  refs.push({
    type: 'tool_execution',
    tool: toolName,
    outcome: String(meta.outcome || 'unknown'),
    error: meta.error ? String(meta.error).slice(0, 200) : null,
    retryable: Boolean(meta.retryable),
    duration_ms: meta.duration_ms || null
  });

  const replyLength = reply ? String(reply).length : 0;
  if (replyLength >= 5000) {
    refs.push({
      type: 'result_truncation',
      reply_length: replyLength,
      was_capped: Boolean(meta.was_capped),
      status: 'could_not_verify'
    });
  }

  return refs;
}

export function classifyEvidenceStatus(evidenceRefs: any[], _toolMeta?: any) {
  if (!Array.isArray(evidenceRefs)) return 'could_not_verify';

  const toolExecution = evidenceRefs.find((ref) => ref.type === 'tool_execution');
  if (!toolExecution) return 'could_not_verify';

  if (toolExecution.outcome === 'invalid_args' || toolExecution.outcome === 'malformed_query') return 'malformed_query';
  if (toolExecution.outcome === 'error' || toolExecution.error) return 'could_not_verify';

  const truncation = evidenceRefs.find((ref) => ref.type === 'result_truncation');
  if (truncation && truncation.status === 'could_not_verify') return 'could_not_verify';

  const searchResult = evidenceRefs.find((ref) => ref.type === 'search_result');
  if (searchResult) return searchResult.status || 'could_not_verify';

  if (toolExecution.outcome === 'ok' || toolExecution.outcome === 'completed') return 'found';
  return 'could_not_verify';
}
