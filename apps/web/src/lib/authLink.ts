export type AuthLinkType = 'invite' | 'recovery' | 'magiclink' | 'signup' | 'email_change' | null;

/** The `type` of the Supabase auth link a page load arrived on (from the URL fragment), or null for a plain load. */
export const readAuthLinkType = (hash: string): AuthLinkType => {
  const type = new URLSearchParams(hash.replace(/^#/, '')).get('type');
  return type === 'invite' || type === 'recovery' || type === 'magiclink' || type === 'signup' || type === 'email_change' ? type : null;
};
