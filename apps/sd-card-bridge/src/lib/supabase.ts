import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let client: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient {
  if (client) return client;
  const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
  if (!url || !anonKey) {
    throw new Error('The bridge requires VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY. Copy the public values from the FCM web environment.');
  }
  client = createClient(url, anonKey, {
    auth: { autoRefreshToken: true, persistSession: false, detectSessionInUrl: false },
  });
  return client;
}