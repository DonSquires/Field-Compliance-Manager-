import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { CAN_SQL, OWNER_EMAILS, resolveEffectiveRole } from './auth.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';

export async function authorizePlatformDiagnostic(req: Request, allowBob = false) {
  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader) return null;

  const caller = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } }
  });
  const { data: { user }, error } = await caller.auth.getUser();
  if (error || !user) return null;

  const appRole = String(user.app_metadata?.role ?? '');
  const appRoles = Array.isArray(user.app_metadata?.roles)
    ? user.app_metadata.roles.map(String)
    : [];
  if (allowBob && (appRole === 'bob' || appRoles.includes('bob'))) {
    return { user, role: 'bob' };
  }

  const isOwner = OWNER_EMAILS.has((user.email ?? '').toLowerCase().trim());
  if (isOwner) return { user, role: 'grand_master' };

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data: profile, error: profileError } = await admin
    .from('user_profiles')
    .select('role')
    .eq('id', user.id)
    .single();
  if (profileError) return null;
  const role = resolveEffectiveRole(user.email, String(profile?.role ?? ''));
  if (!CAN_SQL.has(role)) return null;

  return { user, role };
}
