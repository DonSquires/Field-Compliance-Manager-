function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function message(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 500) : null;
}

export async function builderRequestError(error: unknown, action: unknown): Promise<Error> {
  const source = record(error);
  const context = source.context;
  const operation = typeof action === 'string' ? action.replaceAll('_', ' ') : 'request';
  const prefix = `Builder ${operation} failed`;
  if (context instanceof Response) {
    let payload: Record<string, unknown> = {};
    try {
      payload = record(await context.clone().json());
    } catch {
      // Gateways can return an empty or HTML response instead of the function's JSON.
    }
    const reason = message(payload.error) || message(payload.message);
    const detail = message(payload.detail);
    const stage = message(payload.stage);
    return new Error(`${prefix} (HTTP ${context.status}): ${reason || 'The server did not provide a readable error.'}${detail ? `: ${detail}` : ''}${stage ? ` [${stage}]` : ''}`);
  }
  return new Error(`${prefix}: ${message(source.message) || 'The Builder service could not be reached.'}`);
}
