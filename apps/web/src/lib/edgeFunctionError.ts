/** The edge function's own error text, which supabase-js hides behind "returned a non-2xx status code". */
export async function edgeFunctionErrorMessage(error: unknown, fallback: string): Promise<string> {
  if (error && typeof error === 'object' && 'context' in error && error.context instanceof Response) {
    const body = await error.context.clone().json().catch(() => null) as { error?: unknown; message?: unknown } | null;
    if (typeof body?.error === 'string' && body.error.trim()) return body.error;
    if (typeof body?.message === 'string' && body.message.trim()) return body.message;
  }
  if (error instanceof Error && error.message && !/non-2xx status code/i.test(error.message)) return error.message;
  return fallback;
}
