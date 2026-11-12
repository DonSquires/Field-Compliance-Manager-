import { handleGeminiProxy } from '../_shared/builder-gemini-proxy.mjs';

Deno.serve(async (request: Request) => {
  const response = await handleGeminiProxy(request, {
    env: {
      SUPABASE_SERVICE_ROLE_KEY: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
      GEMINI_API_KEY: Deno.env.get('GEMINI_API_KEY'),
      GOOGLE_API_TOKEN: Deno.env.get('GOOGLE_API_TOKEN'),
    },
  });
  if (response.status >= 400) {
    console.warn(JSON.stringify({ credential_class: 'service_role', provider: 'gemini', status: response.status }));
  }
  return response;
});
