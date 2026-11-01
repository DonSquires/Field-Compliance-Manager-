/**
 * Admin-tier roles. Mirrors ROLE_LEVEL >= ADMIN_LEVEL in supabase/functions/_shared/auth.ts.
 * An admin_officer is an admin who also works in the field and holds the same access as admin
 * (owner ruling 2026-10-27, docs/canon/ACCESS_MODEL.md).
 */
export const ADMIN_TIER_ROLES: ReadonlySet<string> = new Set(['grand_master', 'master', 'admin', 'admin_officer']);

export function isAdminTierRole(role: string | null | undefined): boolean {
  return Boolean(role && ADMIN_TIER_ROLES.has(role));
}
