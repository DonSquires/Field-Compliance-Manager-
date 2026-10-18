import { describe, expect, it } from 'vitest';
import { builderRequestError } from './builderRequestError';

describe('Builder request errors', () => {
  it('shows operation, HTTP status and the function reason without consuming the response', async () => {
    const context = new Response(JSON.stringify({ error: 'Builder job could not run', detail: 'Job is terminal', stage: 'execution' }), { status: 409 });
    const result = await builderRequestError({ context }, 'run');
    expect(result.message).toBe('Builder run failed (HTTP 409): Builder job could not run: Job is terminal [execution]');
    expect(context.bodyUsed).toBe(false);
  });

  it('decodes a gateway message rather than the generic Supabase non-2xx error', async () => {
    const result = await builderRequestError({ context: new Response('{"message":"Invalid JWT"}', { status: 401 }) }, 'create_workspace');
    expect(result.message).toContain('Builder create workspace failed (HTTP 401): Invalid JWT');
  });

  it.each(['<html>gateway error</html>', '', 'null'])('handles a non-object or unreadable response: %s', async body => {
    const result = await builderRequestError({ context: new Response(body, { status: 502 }) }, 'get');
    expect(result.message).toBe('Builder get failed (HTTP 502): The server did not provide a readable error.');
    expect(result.message).not.toContain('html');
  });

  it('retains network failures with operation context', async () => {
    expect((await builderRequestError(new Error('Failed to fetch'), 'list')).message).toBe('Builder list failed: Failed to fetch');
  });
});
