function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function finite(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

// Raw provider errors and model previews stay server-side; the browser receives a bounded category.
export function modelFailure(run: Record<string, unknown>) {
  if (!['failed', 'timeout'].includes(String(run.status))) return null;
  const usage = record(run.usage_metadata);
  const failure = record(usage.failure);
  const error = String(run.error || '').toLowerCase();
  if (usage.output_validated === false || error.includes('output failed validation')) return 'validation';
  if (failure.code === 'model_memory_budget') return 'capacity';
  if (failure.code === 'provider_busy') return 'busy';
  if (error.includes('restarted') || error.includes('runner lost')) return 'interrupted';
  if (error.includes('evidence conflict')) return 'evidence';
  if (failure.code === 'provider_quota' || /no credits|insufficient_quota/.test(error)) return 'quota';
  if (failure.http_status === 429) return 'rate_limit';
  if (run.status === 'timeout' || failure.timeout === true || /timed out|timeout/.test(error)) return 'timeout';
  if (/budget exhausted/.test(error)) return 'budget';
  if (/no tool calls|did not produce tool calls/.test(error)) return 'tool_format';
  if (/unreachable|connection|gateway unavailable|provider unavailable/.test(error)) return 'connection';
  return 'unknown';
}

export function inferenceUsage(value: unknown) {
  const usage = record(value);
  const inference = record(usage.inference);
  return {
    output_validated: typeof usage.output_validated === 'boolean' ? usage.output_validated : null,
    output_tokens_per_second: finite(inference.output_tokens_per_second),
    load_ms: finite(inference.load_ms),
  };
}
