// Public intake for enquiries from the R&M website (verify_jwt = false in
// supabase/config.toml). Contract, rules and HTTP handling live in
// validate.mjs and handler.mjs; this file only wires the Deno runtime.
//
// Secrets: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by the
// platform. WEBSITE_ENQUIRY_SALT salts the client IP hash used for the
// 5-per-hour limit. While it is unset the salt is the SHA-256 of the service
// role key, so rotating that key only restarts the rate-limit windows.
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { createWebsiteEnquiryHandler } from './handler.mjs';
import { sha256Hex } from './validate.mjs';

let serviceClient: SupabaseClient | null = null;

function getServiceClient(): SupabaseClient {
  if (serviceClient) return serviceClient;
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) throw new Error('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not configured');
  serviceClient = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return serviceClient;
}

async function clientHashSalt(): Promise<string> {
  const configured = Deno.env.get('WEBSITE_ENQUIRY_SALT')?.trim();
  if (configured) return configured;
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!key) throw new Error('WEBSITE_ENQUIRY_SALT and SUPABASE_SERVICE_ROLE_KEY are not configured');
  return await sha256Hex(key);
}

Deno.serve(createWebsiteEnquiryHandler({
  submit: async (args: Record<string, unknown>) => {
    const { data, error } = await getServiceClient().rpc('submit_website_enquiry', args);
    return { data, error };
  },
  salt: clientHashSalt,
}));
