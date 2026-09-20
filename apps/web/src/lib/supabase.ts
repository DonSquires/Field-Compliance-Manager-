/**
 * supabase.ts — Supabase client singleton
 *
 * Uses the validated env values from env.ts.
 * Import this wherever Supabase access is needed.
 *
 * The service role key is NEVER used here.
 * It belongs only in server-side Edge Functions.
 *
 * Verified against the original repository (apps/web/src/lib/supabase.ts):
 * persistSession uses localStorage (not sessionStorage) so a durable session
 * survives navigation/refresh/new tabs — a per-tab sessionStorage session was
 * previously found to silently fall back to the anon key on some requests,
 * producing confusing RLS "row violates policy" failures for an apparently
 * logged-in user. Preserving that behavior exactly here.
 */
import { createClient } from '@supabase/supabase-js';
import { env } from './env';

import { readAuthLinkType, type AuthLinkType } from './authLink';

/** Read synchronously at module load: createClient below consumes and clears the URL fragment. */
export const initialAuthLinkType: AuthLinkType = typeof window !== 'undefined' ? readAuthLinkType(window.location.hash) : null;

export const supabase = createClient(env.supabaseUrl, env.supabaseAnonKey, {
  auth: {
    storage: typeof window !== 'undefined' ? window.localStorage : undefined,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: true,
  },
});
