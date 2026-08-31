export function sanitizeEvidenceRefs(toolResult: any, toolName: string) {
  if (!toolResult || typeof toolResult !== 'object') return [];
  const refs: any[] = [];
  const meta = toolResult.meta || {};
  const reply = toolResult.reply || '';
  if ((toolName === 'repo_search' || toolName === 'query_records') && Array.isArray(meta.results)) {
    refs.push({ type: 'search_result', tool: toolName, result_count: meta.results.length, was_capped: Boolean(meta.was_capped), capped_at: meta.capped_at || null, status: meta.results.length ? 'found' : 'not_found' });
    const paths = [...new Set(meta.results.map((result: any) => result?.file_path || result?.path).filter(Boolean))];
    if (paths.length) refs.push({ type: 'file_paths', paths, count: paths.length });
  }
  if (toolName === 'web_research' && Array.isArray(meta.sources)) {
    const urls = meta.sources.map((source: any) => source?.url).filter(Boolean).slice(0, 10);
    if (urls.length) refs.push({ type: 'web_sources', urls, count: urls.length, total_sources: meta.sources.length });
  }
  if ((toolName === 'resolve_geofence' || toolName === 'resolve_address') && meta.geofence) {
    refs.push({ type: 'geofence_resolved', source: meta.geofence.source || 'unknown', location_name: meta.geofence.name || null, address: meta.geofence.address || null, has_boundary: Boolean(meta.geofence.boundary) });
  }
  refs.push({ type: 'tool_execution', tool: toolName, outcome: String(meta.outcome || 'unknown'), error: meta.error ? String(meta.error).slice(0, 200) : null, retryable: Boolean(meta.retryable), duration_ms: meta.duration_ms || null });
  if (reply.length >= 5000) refs.push({ type: 'result_truncation', reply_length: reply.length, was_capped: Boolean(meta.was_capped), status: 'could_not_verify' });
  return refs;
}

export function classifyEvidenceStatus(evidenceRefs: any[]) {
  if (!Array.isArray(evidenceRefs)) return 'could_not_verify';
  const execution = evidenceRefs.find(ref => ref.type === 'tool_execution');
  if (!execution) return 'could_not_verify';
  if (execution.outcome === 'invalid_args' || execution.outcome === 'malformed_query') return 'malformed_query';
  if (execution.outcome === 'error' || execution.error) return 'could_not_verify';
  if (evidenceRefs.some(ref => ref.type === 'result_truncation' && ref.status === 'could_not_verify')) return 'could_not_verify';
  const search = evidenceRefs.find(ref => ref.type === 'search_result');
  if (search) return search.status || 'could_not_verify';
  return execution.outcome === 'ok' || execution.outcome === 'completed' ? 'found' : 'could_not_verify';
}