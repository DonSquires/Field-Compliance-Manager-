/**
 * _shared/auth.ts -- Single source of truth for Bob's authorization model.
 *
 * Every edge function imports from here instead of maintaining its own
 * CAN_PROPOSE / OWNER_EMAILS / effectiveRole logic. Created as part of
 * Pillar C (Epic #135, Issue #138) to eliminate the role-gate drift that
 * caused incidents #107 and #125.
 *
 * @see docs/bob/PILLAR_C_CENTRALIZED_AUTH_DESIGN.md
 */ // ---------------------------------------------------------------------------
// Owner elevation
// ---------------------------------------------------------------------------
/** Platform-owner email elevated to grand_master regardless of DB role. */ export const OWNER_EMAILS = new Set([
  "squires.don@live.com"
]);
/**
 * Resolve the effective role after owner elevation.
 *
 * If the caller's email is in OWNER_EMAILS, returns "grand_master" regardless
 * of the DB role. Otherwise returns the DB role unchanged.
 */ export function resolveEffectiveRole(email, dbRole) {
  const normalized = (email ?? "").toLowerCase().trim();
  if (OWNER_EMAILS.has(normalized)) return "grand_master";
  return dbRole;
}
// ---------------------------------------------------------------------------
// Role gate sets (single definition, used by all downstream functions)
//
// Confirmed against the live code as of the commit that introduced this file:
//   CAN_PROPOSE  -- bob-propose-freedom-camping-zone, bob-propose-client-onboarding,
//                   bob-propose-patrol-route-assignment, bob-propose-zone-patrol-stop,
//                   bob-propose-freedom-camping-org-strategy, bob-job-plan-create
//   CAN_QUERY    -- bob-query-records
//   CAN_SQL      -- bob-sql-read
//   CAN_APPROVE  -- bob-proposal-approver, bob-job-plan-approve
//   CAN_PROMOTE  -- bob-promote-action
//   CAN_WRITE    -- bob-upsert-generic (includes admin_officer)
// ---------------------------------------------------------------------------
export const CAN_PROPOSE = new Set([
  "grand_master",
  "master",
  "admin"
]);
export const CAN_QUERY = new Set([
  "grand_master",
  "master",
  "admin",
  "admin_officer",
  "officer"
]);
export const CAN_SQL = new Set([
  "grand_master",
  "master",
  "admin"
]);
export const CAN_APPROVE = new Set([
  "grand_master",
  "master",
  "admin"
]);
export const CAN_PROMOTE = new Set([
  "grand_master",
  "master",
  "admin"
]);
export const CAN_WRITE = new Set([
  "grand_master",
  "master",
  "admin",
  "admin_officer"
]);
export function roleTier(role) {
  const r = (role || "").toLowerCase();
  if (r === "grand_master") return "admiral";
  if (r === "master") return "captain";
  if (r === "admin") return "commander";
  if (r === "admin_officer") return "officer";
  if (r === "officer") return "ensign";
  return "guest";
}
// ---------------------------------------------------------------------------
// Role hierarchy (mirrors packages/shared/src/accessAreas.ts ROLE_HIERARCHY
// VERBATIM, including nzscv_monitor:1 and client_admin/officer/viewer:1).
//
// Deno edge functions cannot import from packages/shared directly (workspace
// packages are not resolvable in the Deno runtime). This is the Deno-side
// mirror; changes to ROLE_HIERARCHY must be reflected here.
// ---------------------------------------------------------------------------
export const ADMIN_LEVEL = 4;
export const ROLE_LEVEL = {
  grand_master: 6,
  master: 5,
  admin: 4,
  admin_officer: 4,
  officer: 2,
  scan_operator: 2,
  nzscv_monitor: 1,
  client_admin: 1,
  client_officer: 1,
  client_viewer: 1
};
export function roleLevel(role) {
  return ROLE_LEVEL[role] ?? 0;
}
/** True when the role is admin-tier or above (the floor for management areas). */ export function isAdminTier(role) {
  return roleLevel(role) >= ADMIN_LEVEL;
}
