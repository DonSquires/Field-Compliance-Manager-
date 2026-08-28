/**
 * env.ts — validated environment values for the frontend
 *
 * Fails fast (throws) if a required value is missing, rather than letting
 * `undefined` silently reach the Supabase client and produce confusing
 * downstream auth/network errors.
 */
function requireEnv(key: string): string {
  const value = import.meta.env[key];
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
}

export const env = {
  supabaseUrl: requireEnv('VITE_SUPABASE_URL'),
  supabaseAnonKey: requireEnv('VITE_SUPABASE_ANON_KEY'),
};
