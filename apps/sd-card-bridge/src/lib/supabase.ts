import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let client: SupabaseClient | null = null;
let clientPromise: Promise<SupabaseClient> | null = null;

type DesktopClientConfig = {
  supabase_url: string;
  supabase_anon_key: string;
};

export function getSupabaseClient(): Promise<SupabaseClient> {
  if (client) return Promise.resolve(client);
  if (!clientPromise) {
    clientPromise = fetch('https://dotczcyyzgabmtmnglqj.supabase.co/functions/v1/desktop-client-config')
      .then(async (response) => {
        if (!response.ok) throw new Error('FCM desktop connection setup is unavailable. Check your internet connection and try again.');
        return response.json() as Promise<DesktopClientConfig>;
      })
      .then((config) => {
        if (!config.supabase_url || !config.supabase_anon_key) throw new Error('FCM desktop connection setup returned an invalid response.');
        client = createClient(config.supabase_url, config.supabase_anon_key, {
          auth: { autoRefreshToken: true, persistSession: false, detectSessionInUrl: false },
        });
        return client;
      });
  }
  return clientPromise;
}