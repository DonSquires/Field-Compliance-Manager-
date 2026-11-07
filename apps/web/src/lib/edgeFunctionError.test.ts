import { describe, expect, it } from 'vitest';
import { edgeFunctionErrorMessage } from './edgeFunctionError';

const httpError = (body: unknown, status = 400) => Object.assign(new Error('Edge Function returned a non-2xx status code'), {
  context: new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
});

describe('edgeFunctionErrorMessage', () => {
  it('returns the function body error instead of the generic transport text', async () => {
    expect(await edgeFunctionErrorMessage(httpError({ error: 'This officer already has a claimed login' }, 409), 'fallback')).toBe('This officer already has a claimed login');
  });

  it('falls back to message, then the caller wording, never the generic non-2xx text', async () => {
    expect(await edgeFunctionErrorMessage(httpError({ message: 'Rate limited' }, 429), 'fallback')).toBe('Rate limited');
    expect(await edgeFunctionErrorMessage(httpError('not json', 500), 'The invitation could not be sent.')).toBe('The invitation could not be sent.');
    expect(await edgeFunctionErrorMessage(new Error('Failed to fetch'), 'fallback')).toBe('Failed to fetch');
    expect(await edgeFunctionErrorMessage(null, 'fallback')).toBe('fallback');
  });
});
