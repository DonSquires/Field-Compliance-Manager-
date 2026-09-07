import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let client: SupabaseClient | null = null;
export const FCM_SUPABASE_URL = 'https://dotczcyyzgabmtmnglqj.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_5w9B6uzyMnUu_oL52kqjnA_QjuwA2jU';

export function getSupabaseClient(): SupabaseClient {
  if (client) return client;
  client = createClient(FCM_SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: { autoRefreshToken: true, persistSession: false, detectSessionInUrl: false },
  });
  return client;
}