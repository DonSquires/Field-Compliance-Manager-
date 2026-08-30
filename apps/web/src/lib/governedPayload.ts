const SENSITIVE_KEY = /password|passwd|secret|token|api[_-]?key|authorization|credential|private[_-]?key/i;

export function sanitizeGovernedPayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeGovernedPayload);
  if (!value || typeof value !== 'object') return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => [
      key,
      SENSITIVE_KEY.test(key) ? '[REDACTED]' : sanitizeGovernedPayload(child),
    ]),
  );
}

export function formatGovernedPayload(value: unknown): string {
  return JSON.stringify(sanitizeGovernedPayload(value), null, 2);
}