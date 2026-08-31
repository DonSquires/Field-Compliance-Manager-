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

function optionalEnv(key: string): string {
  return import.meta.env[key] ?? '';
}

export const env = {
  get supabaseUrl() {
    return requireEnv('VITE_SUPABASE_URL');
  },
  get supabaseAnonKey() {
    return requireEnv('VITE_SUPABASE_ANON_KEY');
  },
  get bobControlPlaneUrl() {
    return optionalEnv('VITE_BOB_CONTROL_PLANE_URL');
  },
  get bobAdminToken() {
    return optionalEnv('VITE_BOB_ADMIN_TOKEN');
  },
  get appUrl() {
    return optionalEnv('VITE_APP_URL');
  },
  get pttSignalUrl() {
    return optionalEnv('VITE_PTT_SIGNAL_URL');
  },
};
