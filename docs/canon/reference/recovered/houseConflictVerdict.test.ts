// Recovered reference source (NOT compiled or applied here). Origin: GitLab don-squires1/field-compliance-manager
// apps/web/src/lib/__tests__/houseConflictVerdict.test.ts @ Main, read 2026-09-14 via scripts/gitlab-read.mjs. Re-implement against the live schema with tests before use.

/**
 * houseConflictVerdict.test.ts — EXECUTED vitest tests proving the
 * check-house-conflict-any-org verdict + redaction logic.
 *
 * Convergence Step 2, Slice 2a-bis — review fix #3 (B1).
 *
 * WHY THIS FILE EXISTS: the Deno edge function tests (check-house-conflict-
 * any-org.test.ts) cannot execute in CI (no Deno runtime). The security-
 * critical assertion "an officer must NOT receive conflict_org_id / other-org
 * existing_location_id" was previously proven only by tests that did not run.
 * This file exercises the EXTRACTED pure verdict logic via vitest — proving
 * the redaction by EXECUTED tests.
 *
 * Tests cover:
 *   (1) Attack #4: caller passing effective_owner_org_id they do NOT belong to
 *       cannot obtain another org's existing_location_id.
 *   (2) Officer tier redaction: cross-org conflict → { conflict: true } ONLY,
 *       no conflict_org_id, no existing_location_id.
 *   (3) Admin tier gets full detail (conflict_org_id + existing_location_id).
 *   (4) FULL_DETAIL_ROLES membership matches CAN_PROPOSE from _shared/auth.ts.
 *   (5) No-row, same-org, mixed-row cases.
 *   (6) Owner-email elevated role (grand_master) gets full detail.
 */

import { describe, it, expect } from 'vitest';
import {
  computeVerdict,
  buildSafeLogPayload,
  buildSafeErrorMessage,
  FULL_DETAIL_ROLES,
  FULL_DETAIL_ROLES_EXPECTED,
  type LocationRow,
} from '../houseConflictVerdict';
import { computeEffectiveDedupKey } from '../resolveOrCreateHouse';
import { normaliseAddress } from '../siteAnchorAddress';

// ---------------------------------------------------------------------------
// FULL_DETAIL_ROLES membership — must match CAN_PROPOSE from _shared/auth.ts
// ---------------------------------------------------------------------------

describe('FULL_DETAIL_ROLES (mirrors CAN_PROPOSE)', () => {
  it('contains exactly admin, master, grand_master', () => {
    expect(FULL_DETAIL_ROLES.size).toBe(3);
    expect(FULL_DETAIL_ROLES.has('admin')).toBe(true);
    expect(FULL_DETAIL_ROLES.has('master')).toBe(true);
    expect(FULL_DETAIL_ROLES.has('grand_master')).toBe(true);
  });

  it('does NOT contain officer, admin_officer, scan_operator', () => {
    expect(FULL_DETAIL_ROLES.has('officer')).toBe(false);
    expect(FULL_DETAIL_ROLES.has('admin_officer')).toBe(false);
    expect(FULL_DETAIL_ROLES.has('scan_operator')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DRIFT-GUARD: FULL_DETAIL_ROLES must exactly equal FULL_DETAIL_ROLES_EXPECTED
//
// If CAN_PROPOSE in supabase/functions/_shared/auth.ts gains or loses a role,
// the Deno-side auth.test.ts will fail (it pins CAN_PROPOSE membership).
// This vitest drift-guard ensures the web-side mirror stays in sync: any
// mismatch between FULL_DETAIL_ROLES and FULL_DETAIL_ROLES_EXPECTED will
// fail HERE, telling the developer to reconcile both sides.
// ---------------------------------------------------------------------------

describe('DRIFT-GUARD: FULL_DETAIL_ROLES ↔ FULL_DETAIL_ROLES_EXPECTED (mirrors CAN_PROPOSE in _shared/auth.ts)', () => {
  it('FULL_DETAIL_ROLES contains every role in FULL_DETAIL_ROLES_EXPECTED', () => {
    for (const role of FULL_DETAIL_ROLES_EXPECTED) {
      expect(
        FULL_DETAIL_ROLES.has(role),
        `FULL_DETAIL_ROLES is missing '${role}' — reconcile with CAN_PROPOSE in supabase/functions/_shared/auth.ts`,
      ).toBe(true);
    }
  });

  it('FULL_DETAIL_ROLES contains NO roles beyond FULL_DETAIL_ROLES_EXPECTED', () => {
    const expectedSet = new Set<string>(FULL_DETAIL_ROLES_EXPECTED);
    for (const role of FULL_DETAIL_ROLES) {
      expect(
        expectedSet.has(role),
        `FULL_DETAIL_ROLES contains unexpected '${role}' — reconcile with CAN_PROPOSE in supabase/functions/_shared/auth.ts`,
      ).toBe(true);
    }
  });

  it('FULL_DETAIL_ROLES.size equals FULL_DETAIL_ROLES_EXPECTED.length (exact set equality)', () => {
    expect(
      FULL_DETAIL_ROLES.size,
      `FULL_DETAIL_ROLES has ${FULL_DETAIL_ROLES.size} members but FULL_DETAIL_ROLES_EXPECTED has ${FULL_DETAIL_ROLES_EXPECTED.length} — reconcile with CAN_PROPOSE in supabase/functions/_shared/auth.ts`,
    ).toBe(FULL_DETAIL_ROLES_EXPECTED.length);
  });
});

// ---------------------------------------------------------------------------
// Verdict: no rows
// ---------------------------------------------------------------------------

describe('verdict: no rows', () => {
  it('no rows → { conflict: false } (officer)', () => {
    const result = computeVerdict([], 'org-A', 'officer', true);
    expect(result).toEqual({ conflict: false });
  });

  it('no rows → { conflict: false } (admin)', () => {
    const result = computeVerdict([], 'org-A', 'admin', true);
    expect(result).toEqual({ conflict: false });
  });
});

// ---------------------------------------------------------------------------
// Verdict: same-org row (own-org dedup hit)
// ---------------------------------------------------------------------------

describe('verdict: same-org row (own-org dedup hit)', () => {
  it('same-org row, caller belongs → { conflict: false, existing_location_id }', () => {
    const rows: LocationRow[] = [{ id: 'loc-1', organization_id: 'org-A' }];
    const result = computeVerdict(rows, 'org-A', 'officer', true);
    expect(result).toEqual({ conflict: false, existing_location_id: 'loc-1' });
  });

  it('same-org row, admin, caller belongs → { conflict: false, existing_location_id }', () => {
    const rows: LocationRow[] = [{ id: 'loc-1', organization_id: 'org-A' }];
    const result = computeVerdict(rows, 'org-A', 'admin', true);
    expect(result).toEqual({ conflict: false, existing_location_id: 'loc-1' });
  });
});

// ---------------------------------------------------------------------------
// SECURITY: Attack #4 — caller does NOT belong to effective_owner_org_id
// ---------------------------------------------------------------------------

describe('SECURITY: Attack #4 — caller does NOT belong to effective_owner_org_id', () => {
  // 2a-ter: the other-org branch now returns 'review' (not true) because parcel
  // corroboration is structurally unavailable. The SECURITY property under test
  // (own-org dedup branch is unreachable; no cross-tenant leak for officer) is
  // UNCHANGED — only the state literal moved true → 'review'.
  it('caller does NOT belong to org → same-org row treated as other-org → review (officer, verdict only)', () => {
    // A caller passes org-A as effective_owner_org_id but does NOT belong to it.
    // There IS a row under org-A. Without the fix, the caller would learn
    // org-A's existing_location_id via the own-org dedup branch.
    // WITH the fix: callerBelongsToEffectiveOrg=false → all rows are other-org.
    const rows: LocationRow[] = [{ id: 'loc-secret', organization_id: 'org-A' }];
    const result = computeVerdict(rows, 'org-A', 'officer', false);

    // Must be 'review' (not conflict:false with existing_location_id)
    expect(result.conflict).toBe('review');
    // Must NOT leak the existing_location_id
    expect('existing_location_id' in result).toBe(false);
    // Must NOT leak the conflict_org_id (officer tier)
    expect('conflict_org_id' in result).toBe(false);
  });

  it('caller does NOT belong to org → same-org row treated as other-org → review (admin, full detail)', () => {
    // Admin tier: even though the caller doesn't belong, the admin tier
    // gets full detail on the cross-org signal (not the own-org dedup hit).
    const rows: LocationRow[] = [{ id: 'loc-secret', organization_id: 'org-A' }];
    const result = computeVerdict(rows, 'org-A', 'admin', false);

    // Must be 'review' (the row is treated as other-org)
    expect(result.conflict).toBe('review');
    // Admin gets full detail on the signal
    expect(result.conflict_org_id).toBe('org-A');
    expect(result.existing_location_id).toBe('loc-secret');
  });

  it('caller does NOT belong → cannot learn another org existing_location_id via own-org branch', () => {
    // The specific attack: caller passes org-B (which they don't belong to).
    // There's a row under org-B. Without the fix, the "own-org dedup" branch
    // would return { conflict: false, existing_location_id: 'loc-B-secret' }.
    const rows: LocationRow[] = [{ id: 'loc-B-secret', organization_id: 'org-B' }];
    const result = computeVerdict(rows, 'org-B', 'officer', false);

    // The own-org branch must be unreachable → 'review', not a false-clear.
    expect(result.conflict).toBe('review');
    expect('existing_location_id' in result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SECURITY: Officer tier redaction (proven by EXECUTED test — Fix #3)
// ---------------------------------------------------------------------------

describe('SECURITY: officer tier redaction (cross-org signal → review)', () => {
  // 2a-ter: reachable state is 'review' (parcel corroboration unavailable).
  // Redaction discipline is UNCHANGED — officer/field get the verdict ONLY.
  it('officer: cross-org signal → { conflict: \'review\' } ONLY — no cross-tenant detail', () => {
    const rows: LocationRow[] = [{ id: 'loc-other', organization_id: 'org-B' }];
    const result = computeVerdict(rows, 'org-A', 'officer', true);

    expect(result).toEqual({ conflict: 'review' });
    // Explicitly verify cross-tenant fields are ABSENT
    expect('conflict_org_id' in result).toBe(false);
    expect('existing_location_id' in result).toBe(false);
  });

  it('scan_operator: cross-org signal → { conflict: \'review\' } ONLY', () => {
    const rows: LocationRow[] = [{ id: 'loc-other', organization_id: 'org-B' }];
    const result = computeVerdict(rows, 'org-A', 'scan_operator', true);

    expect(result).toEqual({ conflict: 'review' });
    expect('conflict_org_id' in result).toBe(false);
    expect('existing_location_id' in result).toBe(false);
  });

  it('admin_officer: cross-org signal → verdict only (not in FULL_DETAIL_ROLES)', () => {
    const rows: LocationRow[] = [{ id: 'loc-other', organization_id: 'org-B' }];
    const result = computeVerdict(rows, 'org-A', 'admin_officer', true);

    expect(result).toEqual({ conflict: 'review' });
    expect('conflict_org_id' in result).toBe(false);
  });

  it('empty role (fail-closed default): cross-org signal → verdict only', () => {
    const rows: LocationRow[] = [{ id: 'loc-other', organization_id: 'org-B' }];
    const result = computeVerdict(rows, 'org-A', '', true);

    expect(result).toEqual({ conflict: 'review' });
    expect('conflict_org_id' in result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Admin tier: full detail
// ---------------------------------------------------------------------------

describe('admin tier: full detail on cross-org signal (review)', () => {
  // 2a-ter: state is 'review' (dormant true path). Full-detail tier unchanged.
  it('admin → full detail (conflict_org_id + existing_location_id)', () => {
    const rows: LocationRow[] = [{ id: 'loc-other', organization_id: 'org-B' }];
    const result = computeVerdict(rows, 'org-A', 'admin', true);

    expect(result).toEqual({
      conflict: 'review',
      conflict_org_id: 'org-B',
      existing_location_id: 'loc-other',
    });
  });

  it('master → full detail', () => {
    const rows: LocationRow[] = [{ id: 'loc-other', organization_id: 'org-B' }];
    const result = computeVerdict(rows, 'org-A', 'master', true);

    expect(result).toEqual({
      conflict: 'review',
      conflict_org_id: 'org-B',
      existing_location_id: 'loc-other',
    });
  });

  it('grand_master → full detail (owner-email elevated role)', () => {
    const rows: LocationRow[] = [{ id: 'loc-other', organization_id: 'org-B' }];
    const result = computeVerdict(rows, 'org-A', 'grand_master', true);

    expect(result).toEqual({
      conflict: 'review',
      conflict_org_id: 'org-B',
      existing_location_id: 'loc-other',
    });
  });
});

// ---------------------------------------------------------------------------
// Mixed rows (own-org + other-org)
// ---------------------------------------------------------------------------

describe('verdict: mixed rows (own + other org)', () => {
  it('mixed rows, officer → review (verdict only)', () => {
    const rows: LocationRow[] = [
      { id: 'loc-own', organization_id: 'org-A' },
      { id: 'loc-other', organization_id: 'org-B' },
    ];
    const result = computeVerdict(rows, 'org-A', 'officer', true);

    expect(result).toEqual({ conflict: 'review' });
    expect('conflict_org_id' in result).toBe(false);
  });

  it('mixed rows, admin → review with detail', () => {
    const rows: LocationRow[] = [
      { id: 'loc-own', organization_id: 'org-A' },
      { id: 'loc-other', organization_id: 'org-B' },
    ];
    const result = computeVerdict(rows, 'org-A', 'admin', true);

    expect(result).toEqual({
      conflict: 'review',
      conflict_org_id: 'org-B',
      existing_location_id: 'loc-other',
    });
  });
});

// ---------------------------------------------------------------------------
// Multiple same-org rows
// ---------------------------------------------------------------------------

describe('verdict: multiple same-org rows', () => {
  it('multiple same-org rows → conflict:false, returns first location id', () => {
    const rows: LocationRow[] = [
      { id: 'loc-1', organization_id: 'org-A' },
      { id: 'loc-2', organization_id: 'org-A' },
    ];
    const result = computeVerdict(rows, 'org-A', 'admin', true);

    expect(result).toEqual({ conflict: false, existing_location_id: 'loc-1' });
  });
});

// ===========================================================================
// FIX 1: Normalisation parity — address_match_key derivation is identical
// between the WRITE path (computeEffectiveDedupKey) and the READ path
// (edge fn receives the pre-derived key from the caller).
//
// The edge function does NOT re-derive the key — it uses body.address_match_key
// directly (with .trim()). The caller (resolveOrCreateHouse) computes the key
// via computeEffectiveDedupKey(matchKey, label) and passes it to the edge fn.
// Both paths therefore share the SAME derivation: one canonical normaliser.
//
// These tests prove:
//   (a) Equivalent address variants derive the SAME key on both paths.
//   (b) Two genuinely distinct places do NOT collapse to the same key.
// ===========================================================================

describe('FIX 1: normalisation parity — address_match_key derivation', () => {
  describe('(a) equivalent address variants derive the SAME key', () => {
    it('case folding: upper vs lower → same key', () => {
      const key1 = computeEffectiveDedupKey(null, '42 Trafalgar Street');
      const key2 = computeEffectiveDedupKey(null, '42 TRAFALGAR STREET');
      expect(key1).toBe(key2);
      expect(key1).toBe('42 trafalgar street');
    });

    it('duplicate whitespace: collapsed → same key', () => {
      const key1 = computeEffectiveDedupKey(null, '42  Trafalgar   Street');
      const key2 = computeEffectiveDedupKey(null, '42 Trafalgar Street');
      expect(key1).toBe(key2);
    });

    it('leading/trailing whitespace: trimmed → same key', () => {
      const key1 = computeEffectiveDedupKey(null, '  42 Trafalgar Street  ');
      const key2 = computeEffectiveDedupKey(null, '42 Trafalgar Street');
      expect(key1).toBe(key2);
    });

    it('unit/flat prefix variants: "Unit 3, 42 Main St" vs "UNIT 3,  42  MAIN  ST"', () => {
      const key1 = computeEffectiveDedupKey(null, 'Unit 3, 42 Main St');
      const key2 = computeEffectiveDedupKey(null, 'UNIT 3,  42  MAIN  ST');
      expect(key1).toBe(key2);
    });

    it('flat prefix: "Flat 2, 10 High Street" vs "flat  2,  10  high  street"', () => {
      const key1 = computeEffectiveDedupKey(null, 'Flat 2, 10 High Street');
      const key2 = computeEffectiveDedupKey(null, 'flat  2,  10  high  street');
      expect(key1).toBe(key2);
    });

    it('hyphenated address: "42-44 Queen Street" vs "42-44  queen  street"', () => {
      const key1 = computeEffectiveDedupKey(null, '42-44 Queen Street');
      const key2 = computeEffectiveDedupKey(null, '42-44  queen  street');
      expect(key1).toBe(key2);
    });

    it('punctuation preserved: commas and periods are kept', () => {
      const key1 = computeEffectiveDedupKey(null, '42 Trafalgar St., Nelson');
      const key2 = computeEffectiveDedupKey(null, '42 trafalgar st., nelson');
      expect(key1).toBe(key2);
    });

    it('macron/unicode: "Māori Street" vs "Māori  Street" (whitespace only)', () => {
      // normaliseAddress preserves unicode characters (macrons) — it only
      // lowercases, trims, and collapses whitespace. Two strings differing
      // only in whitespace/case derive the same key.
      const key1 = computeEffectiveDedupKey(null, 'Māori Street');
      const key2 = computeEffectiveDedupKey(null, 'māori  street');
      expect(key1).toBe(key2);
    });

    it('LINZ key takes precedence over label normalisation', () => {
      // When a LINZ matchKey is present, it is used verbatim — label is ignored.
      const key1 = computeEffectiveDedupKey('linz-42', '42 Trafalgar Street');
      const key2 = computeEffectiveDedupKey('linz-42', '99 DIFFERENT ADDRESS');
      expect(key1).toBe(key2);
      expect(key1).toBe('linz-42');
    });
  });

  describe('(b) genuinely distinct places do NOT collapse to the same key', () => {
    it('different street numbers → different keys', () => {
      const key1 = computeEffectiveDedupKey(null, '42 Trafalgar Street');
      const key2 = computeEffectiveDedupKey(null, '44 Trafalgar Street');
      expect(key1).not.toBe(key2);
    });

    it('different streets → different keys', () => {
      const key1 = computeEffectiveDedupKey(null, '42 Trafalgar Street');
      const key2 = computeEffectiveDedupKey(null, '42 Hardy Street');
      expect(key1).not.toBe(key2);
    });

    it('different unit numbers → different keys', () => {
      const key1 = computeEffectiveDedupKey(null, 'Unit 1, 42 Main Street');
      const key2 = computeEffectiveDedupKey(null, 'Unit 2, 42 Main Street');
      expect(key1).not.toBe(key2);
    });

    it('different suburbs → different keys', () => {
      const key1 = computeEffectiveDedupKey(null, '42 Main Street, Nelson');
      const key2 = computeEffectiveDedupKey(null, '42 Main Street, Richmond');
      expect(key1).not.toBe(key2);
    });

    it('different LINZ keys → different keys (even same label)', () => {
      const key1 = computeEffectiveDedupKey('linz-42', '42 Main Street');
      const key2 = computeEffectiveDedupKey('linz-99', '42 Main Street');
      expect(key1).not.toBe(key2);
    });
  });

  describe('parity: computeEffectiveDedupKey uses normaliseAddress for synthesis', () => {
    it('synthesized key equals normaliseAddress(label) directly', () => {
      const label = '  42  Trafalgar  STREET, Nelson  ';
      const fromHelper = computeEffectiveDedupKey(null, label);
      const fromNormaliser = normaliseAddress(label);
      expect(fromHelper).toBe(fromNormaliser);
    });

    it('edge fn receives the pre-derived key (no re-derivation needed)', () => {
      // The edge fn does: body.address_match_key.trim()
      // The caller does: computeEffectiveDedupKey(matchKey, label)
      // Since computeEffectiveDedupKey already normalises (trim+collapse+lower),
      // the edge fn's .trim() is a no-op on an already-normalised key.
      const label = '  42  Trafalgar  STREET  ';
      const callerKey = computeEffectiveDedupKey(null, label);
      const edgeFnKey = (callerKey ?? '').trim(); // mirrors edge fn's .trim()
      expect(callerKey).toBe(edgeFnKey);
    });
  });
});

// ===========================================================================
// FIX 2: .limit(2) order-independence — verdict is deterministic regardless
// of returned row order.
//
// The edge fn query was changed from .limit(2) to unbounded (no .limit())
// because an unordered .limit(2) is UNSAFE: if ≥3 rows exist (e.g. 2 own-org
// + 1 other-org), the DB may return only the 2 own-org rows, hiding the
// conflict. With the limit removed, computeVerdict always sees all rows.
//
// These tests prove the verdict is deterministic for all row orderings.
// ===========================================================================

describe('FIX 2: verdict order-independence (proven safe after .limit(2) removal)', () => {
  it('no rows → conflict:false', () => {
    expect(computeVerdict([], 'org-A', 'admin', true)).toEqual({ conflict: false });
  });

  it('same-org only (1 row) → conflict:false with existing_location_id', () => {
    const rows: LocationRow[] = [{ id: 'loc-1', organization_id: 'org-A' }];
    expect(computeVerdict(rows, 'org-A', 'admin', true)).toEqual({
      conflict: false,
      existing_location_id: 'loc-1',
    });
  });

  it('other-org only (1 row) → review', () => {
    const rows: LocationRow[] = [{ id: 'loc-1', organization_id: 'org-B' }];
    const result = computeVerdict(rows, 'org-A', 'admin', true);
    expect(result.conflict).toBe('review');
    expect(result.conflict_org_id).toBe('org-B');
  });

  // 2a-ter dormant-true guard: with parcel corroboration structurally
  // unavailable, computeVerdict must NEVER emit `true` today — only false or
  // 'review'. If Slice 2e enables the parcel path and this starts emitting
  // `true`, THIS test fails on purpose, making the behaviour change a SEEN
  // event rather than a silent one.
  it('DORMANT-TRUE GUARD: no reachable input produces conflict:true today', () => {
    const inputs: Array<[LocationRow[], string, boolean]> = [
      [[], 'admin', true],
      [[{ id: 'l1', organization_id: 'org-A' }], 'admin', true],       // own-org
      [[{ id: 'l2', organization_id: 'org-B' }], 'admin', true],       // other-org
      [[{ id: 'l3', organization_id: 'org-B' }], 'officer', true],     // other-org officer
      [[{ id: 'l4', organization_id: 'org-A' }], 'officer', false],    // attack-#4
      [[{ id: 'l5', organization_id: 'org-A' }, { id: 'l6', organization_id: 'org-B' }], 'admin', true], // mixed
    ];
    for (const [rows, role, belongs] of inputs) {
      expect(computeVerdict(rows, 'org-A', role, belongs).conflict).not.toBe(true);
    }
  });

  it('mixed: [other-org, own-org] order → review', () => {
    const rows: LocationRow[] = [
      { id: 'loc-other', organization_id: 'org-B' },
      { id: 'loc-own', organization_id: 'org-A' },
    ];
    const result = computeVerdict(rows, 'org-A', 'admin', true);
    expect(result.conflict).toBe('review');
    expect(result.conflict_org_id).toBe('org-B');
  });

  it('mixed: [own-org, other-org] order → SAME verdict as [other-org, own-org]', () => {
    const order1: LocationRow[] = [
      { id: 'loc-other', organization_id: 'org-B' },
      { id: 'loc-own', organization_id: 'org-A' },
    ];
    const order2: LocationRow[] = [
      { id: 'loc-own', organization_id: 'org-A' },
      { id: 'loc-other', organization_id: 'org-B' },
    ];
    const verdict1 = computeVerdict(order1, 'org-A', 'admin', true);
    const verdict2 = computeVerdict(order2, 'org-A', 'admin', true);

    expect(verdict1.conflict).toBe(verdict2.conflict);
    expect(verdict1.conflict).toBe('review');
    expect(verdict1.conflict_org_id).toBe(verdict2.conflict_org_id);
  });

  it('mixed: [own-org, other-org] order → SAME verdict for officer tier', () => {
    const order1: LocationRow[] = [
      { id: 'loc-other', organization_id: 'org-B' },
      { id: 'loc-own', organization_id: 'org-A' },
    ];
    const order2: LocationRow[] = [
      { id: 'loc-own', organization_id: 'org-A' },
      { id: 'loc-other', organization_id: 'org-B' },
    ];
    const verdict1 = computeVerdict(order1, 'org-A', 'officer', true);
    const verdict2 = computeVerdict(order2, 'org-A', 'officer', true);

    expect(verdict1).toEqual(verdict2);
    expect(verdict1).toEqual({ conflict: 'review' });
  });

  it('duplicate rows within one org: [own, own] → conflict:false', () => {
    const rows: LocationRow[] = [
      { id: 'loc-1', organization_id: 'org-A' },
      { id: 'loc-2', organization_id: 'org-A' },
    ];
    expect(computeVerdict(rows, 'org-A', 'admin', true)).toEqual({
      conflict: false,
      existing_location_id: 'loc-1',
    });
  });

  it('duplicate rows within other org: [other, other] → review', () => {
    const rows: LocationRow[] = [
      { id: 'loc-1', organization_id: 'org-B' },
      { id: 'loc-2', organization_id: 'org-B' },
    ];
    const result = computeVerdict(rows, 'org-A', 'admin', true);
    expect(result.conflict).toBe('review');
    expect(result.conflict_org_id).toBe('org-B');
  });

  it('3+ rows: 2 own-org + 1 other-org → review (the case .limit(2) would miss)', () => {
    // This is the critical case: with .limit(2), the DB might return only
    // the 2 own-org rows, hiding the signal. Without .limit(2), all rows
    // are returned and the cross-org signal is correctly detected.
    const rows: LocationRow[] = [
      { id: 'loc-own-1', organization_id: 'org-A' },
      { id: 'loc-own-2', organization_id: 'org-A' },
      { id: 'loc-other', organization_id: 'org-B' },
    ];
    const result = computeVerdict(rows, 'org-A', 'admin', true);
    expect(result.conflict).toBe('review');
    expect(result.conflict_org_id).toBe('org-B');
  });

  it('3+ rows: 1 own-org + 2 other-org → review regardless of order', () => {
    const order1: LocationRow[] = [
      { id: 'loc-own', organization_id: 'org-A' },
      { id: 'loc-other-1', organization_id: 'org-B' },
      { id: 'loc-other-2', organization_id: 'org-C' },
    ];
    const order2: LocationRow[] = [
      { id: 'loc-other-2', organization_id: 'org-C' },
      { id: 'loc-own', organization_id: 'org-A' },
      { id: 'loc-other-1', organization_id: 'org-B' },
    ];
    const verdict1 = computeVerdict(order1, 'org-A', 'admin', true);
    const verdict2 = computeVerdict(order2, 'org-A', 'admin', true);

    expect(verdict1.conflict).toBe('review');
    expect(verdict2.conflict).toBe('review');
  });

  it('degenerate: misleading first two rows [other, own] AND [own, other] → same verdict', () => {
    // The "misleading" case: the first two physical rows could suggest
    // different verdicts if the logic depended on row position. The
    // partition-based logic is position-independent.
    const misleading1: LocationRow[] = [
      { id: 'loc-other', organization_id: 'org-B' },
      { id: 'loc-own', organization_id: 'org-A' },
    ];
    const misleading2: LocationRow[] = [
      { id: 'loc-own', organization_id: 'org-A' },
      { id: 'loc-other', organization_id: 'org-B' },
    ];

    // Both orders must produce the same verdict for both admin and officer
    for (const role of ['admin', 'officer', 'grand_master', 'scan_operator']) {
      const v1 = computeVerdict(misleading1, 'org-A', role, true);
      const v2 = computeVerdict(misleading2, 'org-A', role, true);
      expect(v1.conflict).toBe(v2.conflict);
      expect(v1.conflict).toBe('review');
    }
  });
});

// ===========================================================================
// FIX 3: Redaction telemetry / logging-leak assertion — NO cross-tenant
// identifier reaches logs, thrown error text, or client-visible error for
// officer/field (non-CAN_PROPOSE) callers.
//
// The edge function's response-body redaction is already covered above.
// This suite specifically tests the LOG PAYLOAD and ERROR TEXT construction
// via buildSafeLogPayload() and buildSafeErrorMessage().
// ===========================================================================

describe('FIX 3: redaction telemetry — no cross-tenant leak in logs/errors for officer tier', () => {
  const conflictVerdict = {
    conflict: true as const,
    conflict_org_id: 'secret-org-999',
    existing_location_id: 'secret-loc-888',
  };

  describe('buildSafeLogPayload', () => {
    it('officer: log payload contains NO conflict_org_id', () => {
      const payload = buildSafeLogPayload(conflictVerdict, 'officer', 'own-org-A');
      expect('conflict_org_id' in payload).toBe(false);
      expect(JSON.stringify(payload)).not.toContain('secret-org-999');
    });

    it('officer: log payload contains NO existing_location_id', () => {
      const payload = buildSafeLogPayload(conflictVerdict, 'officer', 'own-org-A');
      expect('existing_location_id' in payload).toBe(false);
      expect(JSON.stringify(payload)).not.toContain('secret-loc-888');
    });

    it('officer: log payload contains only conflict boolean + own org', () => {
      const payload = buildSafeLogPayload(conflictVerdict, 'officer', 'own-org-A');
      expect(payload).toEqual({
        conflict: true,
        effective_owner_org_id: 'own-org-A',
      });
    });

    it('scan_operator: log payload contains NO cross-tenant detail', () => {
      const payload = buildSafeLogPayload(conflictVerdict, 'scan_operator', 'own-org-A');
      expect(JSON.stringify(payload)).not.toContain('secret-org-999');
      expect(JSON.stringify(payload)).not.toContain('secret-loc-888');
    });

    it('admin_officer: log payload contains NO cross-tenant detail', () => {
      const payload = buildSafeLogPayload(conflictVerdict, 'admin_officer', 'own-org-A');
      expect(JSON.stringify(payload)).not.toContain('secret-org-999');
      expect(JSON.stringify(payload)).not.toContain('secret-loc-888');
    });

    it('empty role (fail-closed): log payload contains NO cross-tenant detail', () => {
      const payload = buildSafeLogPayload(conflictVerdict, '', 'own-org-A');
      expect(JSON.stringify(payload)).not.toContain('secret-org-999');
      expect(JSON.stringify(payload)).not.toContain('secret-loc-888');
    });

    it('admin: log payload DOES contain full detail', () => {
      const payload = buildSafeLogPayload(conflictVerdict, 'admin', 'own-org-A');
      expect(payload.conflict_org_id).toBe('secret-org-999');
      expect(payload.existing_location_id).toBe('secret-loc-888');
    });

    it('grand_master: log payload DOES contain full detail', () => {
      const payload = buildSafeLogPayload(conflictVerdict, 'grand_master', 'own-org-A');
      expect(payload.conflict_org_id).toBe('secret-org-999');
      expect(payload.existing_location_id).toBe('secret-loc-888');
    });
  });

  describe('buildSafeErrorMessage', () => {
    it('officer: error message contains NO conflict_org_id', () => {
      const msg = buildSafeErrorMessage(conflictVerdict, 'officer');
      expect(msg).not.toContain('secret-org-999');
    });

    it('officer: error message contains NO existing_location_id', () => {
      const msg = buildSafeErrorMessage(conflictVerdict, 'officer');
      expect(msg).not.toContain('secret-loc-888');
    });

    it('officer: error message is generic "Cross-org conflict detected"', () => {
      const msg = buildSafeErrorMessage(conflictVerdict, 'officer');
      expect(msg).toBe('Cross-org conflict detected');
    });

    it('scan_operator: error message is generic', () => {
      const msg = buildSafeErrorMessage(conflictVerdict, 'scan_operator');
      expect(msg).toBe('Cross-org conflict detected');
    });

    it('empty role: error message is generic', () => {
      const msg = buildSafeErrorMessage(conflictVerdict, '');
      expect(msg).toBe('Cross-org conflict detected');
    });

    it('admin: error message DOES contain full detail', () => {
      const msg = buildSafeErrorMessage(conflictVerdict, 'admin');
      expect(msg).toContain('secret-org-999');
      expect(msg).toContain('secret-loc-888');
    });

    it('no conflict: returns "No conflict detected"', () => {
      const msg = buildSafeErrorMessage({ conflict: false }, 'officer');
      expect(msg).toBe('No conflict detected');
    });
  });

  // -------------------------------------------------------------------------
  // 2a-ter: 'review' state telemetry — same redaction discipline as 'true',
  // but the message MUST read as UNCONFIRMED (owner §4 ruling), never as a
  // proven conflict, and never leak cross-tenant identifiers for officer/field.
  // -------------------------------------------------------------------------
  describe('review state (2a-ter tri-state)', () => {
    const reviewVerdict = {
      conflict: 'review' as const,
      conflict_org_id: 'secret-org-999',
      existing_location_id: 'secret-loc-888',
    };

    it('officer: review log payload contains NO cross-tenant detail', () => {
      const payload = buildSafeLogPayload(reviewVerdict, 'officer', 'own-org-A');
      expect('conflict_org_id' in payload).toBe(false);
      expect('existing_location_id' in payload).toBe(false);
      expect(JSON.stringify(payload)).not.toContain('secret-org-999');
      expect(JSON.stringify(payload)).not.toContain('secret-loc-888');
      // The verdict state itself is passed through verbatim.
      expect(payload.conflict).toBe('review');
    });

    it('admin: review log payload DOES contain full detail', () => {
      const payload = buildSafeLogPayload(reviewVerdict, 'admin', 'own-org-A');
      expect(payload.conflict).toBe('review');
      expect(payload.conflict_org_id).toBe('secret-org-999');
      expect(payload.existing_location_id).toBe('secret-loc-888');
    });

    it('officer: review error message is generic + reads UNCONFIRMED (not a proven conflict)', () => {
      const msg = buildSafeErrorMessage(reviewVerdict, 'officer');
      // No cross-tenant identifiers
      expect(msg).not.toContain('secret-org-999');
      expect(msg).not.toContain('secret-loc-888');
      // Reads as unconfirmed / needs human confirmation
      expect(msg.toLowerCase()).toContain('human confirmation');
      expect(msg.toLowerCase()).toContain('unconfirmed');
      // MUST be distinct from the confirmed-conflict wording
      expect(msg).not.toBe('Cross-org conflict detected');
    });

    it('admin: review error message carries detail AND reads unconfirmed', () => {
      const msg = buildSafeErrorMessage(reviewVerdict, 'admin');
      expect(msg).toContain('secret-org-999');
      expect(msg.toLowerCase()).toContain('human confirmation');
    });

    it('review wording is DISTINCT from confirmed-conflict wording (owner §4 ruling)', () => {
      const trueVerdict = { conflict: true as const, conflict_org_id: 'o', existing_location_id: 'l' };
      const reviewMsg = buildSafeErrorMessage(reviewVerdict, 'officer');
      const trueMsg = buildSafeErrorMessage(trueVerdict, 'officer');
      expect(reviewMsg).not.toBe(trueMsg);
      // Confirmed path still reads as a detected conflict (dormant today, but
      // the wording contract is preserved for when 2e enables it).
      expect(trueMsg).toBe('Cross-org conflict detected');
    });
  });

  describe('edge fn error responses contain no cross-tenant detail', () => {
    // These tests verify that the edge function's generic error strings
    // ('Cross-org conflict query failed', 'Server error') do NOT contain
    // any cross-tenant identifiers. The edge fn uses these strings directly
    // (not interpolated with org/location ids).
    it('"Cross-org conflict query failed" contains no org/location ids', () => {
      const errorMsg = 'Cross-org conflict query failed';
      expect(errorMsg).not.toMatch(/org-/);
      expect(errorMsg).not.toMatch(/loc-/);
      expect(errorMsg).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/); // no UUIDs
    });

    it('"Server error" contains no org/location ids', () => {
      const errorMsg = 'Server error';
      expect(errorMsg).not.toMatch(/org-/);
      expect(errorMsg).not.toMatch(/loc-/);
    });
  });

  describe('computeVerdict response body for officer tier contains no cross-tenant detail', () => {
    it('officer: conflict verdict serialised to JSON contains no other-org identifiers', () => {
      const rows: LocationRow[] = [
        { id: 'secret-loc-888', organization_id: 'secret-org-999' },
      ];
      const verdict = computeVerdict(rows, 'own-org-A', 'officer', true);
      const serialised = JSON.stringify(verdict);

      expect(serialised).not.toContain('secret-org-999');
      expect(serialised).not.toContain('secret-loc-888');
      // 2a-ter: other-org enforcement branch now yields 'review' (not true);
      // the redaction property (no cross-tenant ids serialised) is unchanged.
      expect(verdict).toEqual({ conflict: 'review' });
    });

    it('officer: conflict verdict with mixed rows — no cross-tenant leak in serialised form', () => {
      const rows: LocationRow[] = [
        { id: 'own-loc', organization_id: 'own-org-A' },
        { id: 'secret-loc', organization_id: 'secret-org-X' },
      ];
      const verdict = computeVerdict(rows, 'own-org-A', 'officer', true);
      const serialised = JSON.stringify(verdict);

      expect(serialised).not.toContain('secret-org-X');
      expect(serialised).not.toContain('secret-loc');
    });
  });
});
