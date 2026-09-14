// Recovered reference source (NOT compiled or applied here). Origin: GitLab don-squires1/field-compliance-manager
// apps/web/src/lib/__tests__/resolveOrCreateHouse.test.ts @ Main, read 2026-09-14 via scripts/gitlab-read.mjs. Re-implement against the live schema with tests before use.

/**
 * resolveOrCreateHouse.test.ts — Unit tests for the canonical house
 * (locations) place-attach helper.
 *
 * Convergence Step 2, Slice 2a (CONVERGENCE_STEP2_WRITE_PATH.md §3 / §3.2)
 * + Slice 2a-bis (CONVERGENCE_STEP2_SLICE2ABIS_M3_EDGE.md §7).
 *
 * Tests that matter (per the slice contract):
 *   (1) same address + ENFORCEMENT origin → house owned by the place-record
 *       org, NOT the caller org.
 *   (2) same address + ORDINARY origin → house owned by the caller org.
 *   (3) existing dedup hit → reuses the same house/location_id, no duplicate.
 *   (4) org-mismatch case → proves the helper never silently attaches an
 *       enforcement place to the operator org.
 *
 * Review-required regression tests (M1–M4):
 *   (a) M1: two null-match-key same-label calls → exactly ONE house created.
 *   (b) M2: same address under ordinary vs enforcement → two DIFFERENT houses
 *       under different effective owners, no collision.
 *   (c) M3: existing house with same address key but wrong org for enforcement
 *       → explicit stop/flag (throw). NOW via check-house-conflict-any-org
 *       edge fn (Slice 2a-bis).
 *   (d) M4: enforcement resolution unavailable / role-denied → throws, never
 *       caller-org fallback.
 *   (e) Idempotent reuse under identical resolved inputs (dedup hit).
 *
 * Slice 2a-bis acceptance (§7):
 *   (f) Edge fn invoke error → helper THROWS (fail-loud, F2 discipline).
 *   (g) Officer-tier stops on conflict:true WITHOUT needing the org id.
 *   (h) Admin-tier stops on conflict:true WITH full detail in error message.
 *   (i) Ordinary path unchanged — no edge round-trip for ordinary origins.
 *   (j) Enforcement invokes check-house-conflict-any-org with correct body.
 *
 * Mocks: bob-propose-place-org-from-parcel and check-house-conflict-any-org
 * are mocked (not called live). Supabase client is a mock object injected
 * via the helper's DI parameter.
 *
 * Issues: Step 2 / Slice 2a (CONVERGENCE_STEP2_WRITE_PATH.md §8),
 *         Slice 2a-bis (CONVERGENCE_STEP2_SLICE2ABIS_M3_EDGE.md).
 */

import { describe, it, expect, vi } from 'vitest';
import {
  resolveEffectiveOwnerOrg,
  resolveOrCreateHouse,
  computeEffectiveDedupKey,
  ENFORCEMENT_ORIGINS,
  ORDINARY_ORIGINS,
  ALL_RECOGNISED_ORIGINS,
  type ResolveOrCreateHouseInput,
  type ResolvedParcel,
  type HouseOrigin,
} from '../resolveOrCreateHouse';

// ---------------------------------------------------------------------------
// Mock Supabase client factory
// ---------------------------------------------------------------------------

/**
 * Build a mock SupabaseClient with configurable responses.
 *
 * The mock supports:
 *   - .functions.invoke() — for bob-propose-place-org-from-parcel
 *   - .from('locations').select().eq().eq().limit().maybeSingle() — for dedup
 *   - .from('locations').insert().select().single() — for create
 *
 * M1/M3 support: conflictCheckResponse provides the response for the
 * M3 cross-org conflict check via the `check-house-conflict-any-org` edge
 * function (Slice 2a-bis). The invoke mock dispatches by function name.
 */
function buildMockSupabase(overrides?: {
  /** Response from bob-propose-place-org-from-parcel invoke. */
  placeOrgResponse?: { data: unknown; error: unknown };
  /** Response from locations dedup query (maybeSingle). */
  dedupResponse?: { data: unknown; error?: unknown };
  /** Response from locations insert (single). */
  insertResponse?: { data: unknown; error?: unknown };
  /**
   * Response from the M3 cross-org conflict check edge function
   * (check-house-conflict-any-org). Replaces the former anyOrgDedupResponse.
   * Default: { conflict: false } (no cross-org conflict).
   */
  conflictCheckResponse?: { data: unknown; error?: unknown };
}) {
  const placeOrgResponse = overrides?.placeOrgResponse ?? {
    data: { organization_id: 'place-org-001' },
    error: null,
  };
  const dedupResponse = overrides?.dedupResponse ?? { data: null, error: null };
  const insertResponse = overrides?.insertResponse ?? {
    data: { id: 'loc-new-001', name: 'Test House' },
    error: null,
  };
  const conflictCheckResponse = overrides?.conflictCheckResponse ?? {
    data: { conflict: false },
    error: null,
  };

  // Chain builder for .from('locations').select().eq().eq().limit().maybeSingle()
  // (org-scoped dedup)
  const maybeSingleFn = vi.fn().mockResolvedValue(dedupResponse);
  const limitFn = vi.fn().mockReturnValue({ maybeSingle: maybeSingleFn });
  const eqFns = [
    vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ limit: limitFn }) }),
  ];
  const selectForDedupFn = vi.fn().mockReturnValue({ eq: eqFns[0] });

  // Chain builder for .from('locations').insert().select().single()
  const singleFn = vi.fn().mockResolvedValue(insertResponse);
  const selectForInsertFn = vi.fn().mockReturnValue({ single: singleFn });
  const insertFn = vi.fn().mockReturnValue({ select: selectForInsertFn });

  const fromFn = vi.fn().mockImplementation((table: string) => {
    if (table !== 'locations') {
      throw new Error(`Unexpected table: ${table}`);
    }
    return {
      select: selectForDedupFn,
      insert: insertFn,
    };
  });

  // Invoke mock dispatches by function name:
  //   - 'bob-propose-place-org-from-parcel' → placeOrgResponse
  //   - 'check-house-conflict-any-org' → conflictCheckResponse
  const invokeFn = vi.fn().mockImplementation((fnName: string) => {
    if (fnName === 'check-house-conflict-any-org') {
      return Promise.resolve(conflictCheckResponse);
    }
    // Default: bob-propose-place-org-from-parcel (or any other)
    return Promise.resolve(placeOrgResponse);
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client = {
    from: fromFn,
    functions: { invoke: invokeFn },
  } as any;

  return {
    client,
    invokeFn,
    fromFn,
    insertFn,
    maybeSingleFn,
    selectForDedupFn,
    selectForInsertFn,
  };
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const CALLER_ORG = 'operator-org-123';
const PLACE_ORG = 'place-org-001';
const EXISTING_LOCATION_ID = 'loc-existing-999';
const NEW_LOCATION_ID = 'loc-new-001';

const MATCH_KEY = 'linz-addr-42';
const ADDRESS_LABEL = '42 Trafalgar Street, Nelson 7010';

const PARCEL: ResolvedParcel = {
  parcelPolygon: {
    type: 'Polygon',
    coordinates: [[[172.0, -41.0], [172.1, -41.0], [172.1, -41.1], [172.0, -41.1], [172.0, -41.0]]],
  },
  parcelId: 'parcel-42',
};

const BASE_ADDRESS = {
  addressMatchKey: MATCH_KEY,
  label: ADDRESS_LABEL,
  lat: -41.27 as number | null,
  lng: 173.28 as number | null,
};

// ---------------------------------------------------------------------------
// computeEffectiveDedupKey — unit tests (M1 + S2)
// ---------------------------------------------------------------------------

describe('computeEffectiveDedupKey', () => {
  it('returns the LINZ matchKey when available', () => {
    expect(computeEffectiveDedupKey('linz-123', 'Some Label')).toBe('linz-123');
  });

  it('synthesizes from label using normaliseAddress when matchKey is null', () => {
    expect(computeEffectiveDedupKey(null, '42  Trafalgar  Street')).toBe('42 trafalgar street');
  });

  it('synthesizes from label: trims, collapses whitespace, lowercases', () => {
    expect(computeEffectiveDedupKey(null, '  27 IVY   CRESCENT  ')).toBe('27 ivy crescent');
  });

  it('returns null when both matchKey and label are absent', () => {
    expect(computeEffectiveDedupKey(null, null)).toBeNull();
    expect(computeEffectiveDedupKey(null, '')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveEffectiveOwnerOrg — pinned independently (§3.2)
// ---------------------------------------------------------------------------

describe('resolveEffectiveOwnerOrg', () => {
  describe('ENFORCEMENT origins → reassign to place-record org', () => {
    it.each([...ENFORCEMENT_ORIGINS] as HouseOrigin[])(
      'origin "%s" reassigns to the place-record org, NOT the caller org',
      async (origin) => {
        const { client, invokeFn } = buildMockSupabase({
          placeOrgResponse: { data: { organization_id: PLACE_ORG }, error: null },
        });

        const result = await resolveEffectiveOwnerOrg(
          CALLER_ORG, origin, PARCEL, ADDRESS_LABEL, MATCH_KEY, -41.27, 173.28, client,
        );

        expect(result.effectiveOwnerOrgId).toBe(PLACE_ORG);
        expect(result.effectiveOwnerOrgId).not.toBe(CALLER_ORG);
        expect(result.resolution).toBe('reassigned');
        expect(invokeFn).toHaveBeenCalledWith(
          'bob-propose-place-org-from-parcel',
          expect.objectContaining({
            body: expect.objectContaining({
              gps_lat: -41.27,
              gps_lng: 173.28,
              parcel_polygon: PARCEL.parcelPolygon,
            }),
          }),
        );
      },
    );

    it('throws when enforcement origin has no parcel polygon (refuses silent fallback)', async () => {
      const { client } = buildMockSupabase();

      await expect(
        resolveEffectiveOwnerOrg(
          CALLER_ORG, 'enforcement', null, ADDRESS_LABEL, MATCH_KEY, -41.27, 173.28, client,
        ),
      ).rejects.toThrow('enforcement origin requires a resolved parcel polygon');
    });

    it('throws when enforcement origin has no lat/lng', async () => {
      const { client } = buildMockSupabase();

      await expect(
        resolveEffectiveOwnerOrg(
          CALLER_ORG, 'enforcement', PARCEL, ADDRESS_LABEL, MATCH_KEY, null, null, client,
        ),
      ).rejects.toThrow('enforcement origin requires lat/lng');
    });

    it('throws when bob-propose-place-org-from-parcel returns an error (M4)', async () => {
      const { client } = buildMockSupabase({
        placeOrgResponse: { data: null, error: { message: 'Edge function failed' } },
      });

      await expect(
        resolveEffectiveOwnerOrg(
          CALLER_ORG, 'enforcement', PARCEL, ADDRESS_LABEL, MATCH_KEY, -41.27, 173.28, client,
        ),
      ).rejects.toThrow('place-org resolution failed');
    });

    it('throws when bob-propose-place-org-from-parcel returns no organization_id', async () => {
      const { client } = buildMockSupabase({
        placeOrgResponse: { data: { error: 'no parcel match' }, error: null },
      });

      await expect(
        resolveEffectiveOwnerOrg(
          CALLER_ORG, 'enforcement', PARCEL, ADDRESS_LABEL, MATCH_KEY, -41.27, 173.28, client,
        ),
      ).rejects.toThrow('returned no organization_id');
    });

    // M4: enforcement error message names the role/gov requirement
    it('M4: enforcement error message names the role/gov requirement', async () => {
      const { client } = buildMockSupabase({
        placeOrgResponse: { data: null, error: { message: 'Forbidden: insufficient role' } },
      });

      await expect(
        resolveEffectiveOwnerOrg(
          CALLER_ORG, 'enforcement', PARCEL, ADDRESS_LABEL, MATCH_KEY, -41.27, 173.28, client,
        ),
      ).rejects.toThrow(/admin.*master.*grand_master/);
    });
  });

  describe('ORDINARY origins → retain the caller org', () => {
    it.each([...ORDINARY_ORIGINS] as HouseOrigin[])(
      'origin "%s" retains the caller org',
      async (origin) => {
        const { client, invokeFn } = buildMockSupabase();

        const result = await resolveEffectiveOwnerOrg(
          CALLER_ORG, origin, null, ADDRESS_LABEL, MATCH_KEY, -41.27, 173.28, client,
        );

        expect(result.effectiveOwnerOrgId).toBe(CALLER_ORG);
        expect(result.resolution).toBe('retained');
        expect(invokeFn).not.toHaveBeenCalled();
      },
    );

    it('retains caller org even when a parcel is provided (ordinary origin)', async () => {
      const { client, invokeFn } = buildMockSupabase();

      const result = await resolveEffectiveOwnerOrg(
        CALLER_ORG, 'contracted', PARCEL, ADDRESS_LABEL, MATCH_KEY, -41.27, 173.28, client,
      );

      expect(result.effectiveOwnerOrgId).toBe(CALLER_ORG);
      expect(result.resolution).toBe('retained');
      expect(invokeFn).not.toHaveBeenCalled();
    });
  });

  // S1: unrecognised origin throws
  describe('S1: unrecognised origin → throws', () => {
    it('throws for an unrecognised origin string', async () => {
      const { client } = buildMockSupabase();

      await expect(
        resolveEffectiveOwnerOrg(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          CALLER_ORG, 'unknown-origin' as any, null, ADDRESS_LABEL, MATCH_KEY, -41.27, 173.28, client,
        ),
      ).rejects.toThrow("unrecognised origin 'unknown-origin'");
    });

    it('does not silently default to caller-org for unrecognised origin', async () => {
      const { client } = buildMockSupabase();

      await expect(
        resolveEffectiveOwnerOrg(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          CALLER_ORG, 'custom-module' as any, null, ADDRESS_LABEL, MATCH_KEY, -41.27, 173.28, client,
        ),
      ).rejects.toThrow('must not silently default');
    });
  });
});

// ---------------------------------------------------------------------------
// resolveOrCreateHouse — full pipeline
// ---------------------------------------------------------------------------

describe('resolveOrCreateHouse', () => {
  // ── Test (1): ENFORCEMENT origin → house owned by place-record org ──

  it('ENFORCEMENT origin: house is owned by the place-record org, NOT the caller org', async () => {
    const { client } = buildMockSupabase({
      placeOrgResponse: { data: { organization_id: PLACE_ORG }, error: null },
      dedupResponse: { data: null },
      insertResponse: { data: { id: NEW_LOCATION_ID, name: ADDRESS_LABEL }, error: null },
    });

    const input: ResolveOrCreateHouseInput = {
      callerOrgId: CALLER_ORG,
      origin: 'enforcement',
      address: BASE_ADDRESS,
      parcel: PARCEL,
    };

    const result = await resolveOrCreateHouse(input, client);

    expect(result.effectiveOwnerOrgId).toBe(PLACE_ORG);
    expect(result.effectiveOwnerOrgId).not.toBe(CALLER_ORG);
    expect(result.locationId).toBe(NEW_LOCATION_ID);
    expect(result.action).toBe('created');
  });

  // ── Test (2): ORDINARY origin → house owned by the caller org ──

  it('ORDINARY origin: house is owned by the caller org', async () => {
    const { client } = buildMockSupabase({
      dedupResponse: { data: null },
      insertResponse: { data: { id: NEW_LOCATION_ID, name: ADDRESS_LABEL }, error: null },
    });

    const input: ResolveOrCreateHouseInput = {
      callerOrgId: CALLER_ORG,
      origin: 'contracted',
      address: BASE_ADDRESS,
    };

    const result = await resolveOrCreateHouse(input, client);

    expect(result.effectiveOwnerOrgId).toBe(CALLER_ORG);
    expect(result.locationId).toBe(NEW_LOCATION_ID);
    expect(result.action).toBe('created');
  });

  // ── Test (3): existing dedup hit → reuses the same house, no duplicate ──

  it('existing dedup hit: reuses the same house/location_id, no duplicate create', async () => {
    const { client, insertFn } = buildMockSupabase({
      dedupResponse: {
        data: { id: EXISTING_LOCATION_ID, name: ADDRESS_LABEL, address: ADDRESS_LABEL, organization_id: CALLER_ORG },
      },
    });

    const input: ResolveOrCreateHouseInput = {
      callerOrgId: CALLER_ORG,
      origin: 'contracted',
      address: BASE_ADDRESS,
    };

    const result = await resolveOrCreateHouse(input, client);

    expect(result.locationId).toBe(EXISTING_LOCATION_ID);
    expect(result.action).toBe('existing');
    expect(result.effectiveOwnerOrgId).toBe(CALLER_ORG);
    expect(insertFn).not.toHaveBeenCalled();
  });

  // ── Test (4): org-mismatch case → enforcement place NEVER attached to operator org ──

  it('org-mismatch: enforcement place is NEVER silently attached to the operator org', async () => {
    const DIFFERENT_PLACE_ORG = 'place-org-DIFFERENT';
    const { client } = buildMockSupabase({
      placeOrgResponse: { data: { organization_id: DIFFERENT_PLACE_ORG }, error: null },
      dedupResponse: { data: null },
      insertResponse: { data: { id: NEW_LOCATION_ID, name: ADDRESS_LABEL }, error: null },
    });

    const input: ResolveOrCreateHouseInput = {
      callerOrgId: CALLER_ORG,
      origin: 'noise',
      address: BASE_ADDRESS,
      parcel: PARCEL,
    };

    const result = await resolveOrCreateHouse(input, client);

    expect(result.effectiveOwnerOrgId).toBe(DIFFERENT_PLACE_ORG);
    expect(result.effectiveOwnerOrgId).not.toBe(CALLER_ORG);
    expect(result.action).toBe('created');
  });

  // ── Enforcement dedup: existing house under the place-record org ──

  it('ENFORCEMENT dedup: reuses existing house under the place-record org', async () => {
    const { client, insertFn } = buildMockSupabase({
      placeOrgResponse: { data: { organization_id: PLACE_ORG }, error: null },
      dedupResponse: {
        data: { id: EXISTING_LOCATION_ID, name: ADDRESS_LABEL, address: ADDRESS_LABEL, organization_id: PLACE_ORG },
      },
    });

    const input: ResolveOrCreateHouseInput = {
      callerOrgId: CALLER_ORG,
      origin: 'enforcement',
      address: BASE_ADDRESS,
      parcel: PARCEL,
    };

    const result = await resolveOrCreateHouse(input, client);

    expect(result.locationId).toBe(EXISTING_LOCATION_ID);
    expect(result.effectiveOwnerOrgId).toBe(PLACE_ORG);
    expect(result.action).toBe('existing');
    expect(insertFn).not.toHaveBeenCalled();
  });

  // ── Edge cases ──

  it('throws when house name is empty and address label is empty', async () => {
    const { client } = buildMockSupabase();

    const input: ResolveOrCreateHouseInput = {
      callerOrgId: CALLER_ORG,
      origin: 'contracted',
      address: { ...BASE_ADDRESS, label: null },
      name: '',
    };

    await expect(resolveOrCreateHouse(input, client)).rejects.toThrow('house name is required');
  });

  it('uses input name over address label when both provided', async () => {
    const { client } = buildMockSupabase({
      dedupResponse: { data: null },
      insertResponse: { data: { id: NEW_LOCATION_ID, name: 'Custom Name' }, error: null },
    });

    const input: ResolveOrCreateHouseInput = {
      callerOrgId: CALLER_ORG,
      origin: 'contracted',
      address: BASE_ADDRESS,
      name: 'Custom Name',
    };

    const result = await resolveOrCreateHouse(input, client);

    expect(result.locationId).toBe(NEW_LOCATION_ID);
    expect(result.action).toBe('created');
  });

  it('throws when locations insert fails', async () => {
    const { client } = buildMockSupabase({
      dedupResponse: { data: null },
      insertResponse: { data: null, error: { message: 'RLS violation' } },
    });

    const input: ResolveOrCreateHouseInput = {
      callerOrgId: CALLER_ORG,
      origin: 'contracted',
      address: BASE_ADDRESS,
    };

    await expect(resolveOrCreateHouse(input, client)).rejects.toThrow('locations insert failed');
  });

  it('enforcement with no parcel: throws (refuses silent fallback to operator)', async () => {
    const { client } = buildMockSupabase();

    const input: ResolveOrCreateHouseInput = {
      callerOrgId: CALLER_ORG,
      origin: 'enforcement',
      address: BASE_ADDRESS,
      parcel: null,
    };

    await expect(resolveOrCreateHouse(input, client)).rejects.toThrow(
      'enforcement origin requires a resolved parcel polygon',
    );
  });

  it('biosecurity origin: house owned by place-record org (enforcement family)', async () => {
    const { client } = buildMockSupabase({
      placeOrgResponse: { data: { organization_id: PLACE_ORG }, error: null },
      dedupResponse: { data: null },
      insertResponse: { data: { id: NEW_LOCATION_ID, name: ADDRESS_LABEL }, error: null },
    });

    const input: ResolveOrCreateHouseInput = {
      callerOrgId: CALLER_ORG,
      origin: 'biosecurity',
      address: BASE_ADDRESS,
      parcel: PARCEL,
    };

    const result = await resolveOrCreateHouse(input, client);

    expect(result.effectiveOwnerOrgId).toBe(PLACE_ORG);
    expect(result.effectiveOwnerOrgId).not.toBe(CALLER_ORG);
  });

  it('smoke origin: house owned by place-record org (enforcement family)', async () => {
    const { client } = buildMockSupabase({
      placeOrgResponse: { data: { organization_id: PLACE_ORG }, error: null },
      dedupResponse: { data: null },
      insertResponse: { data: { id: NEW_LOCATION_ID, name: ADDRESS_LABEL }, error: null },
    });

    const input: ResolveOrCreateHouseInput = {
      callerOrgId: CALLER_ORG,
      origin: 'smoke',
      address: BASE_ADDRESS,
      parcel: PARCEL,
    };

    const result = await resolveOrCreateHouse(input, client);

    expect(result.effectiveOwnerOrgId).toBe(PLACE_ORG);
    expect(result.effectiveOwnerOrgId).not.toBe(CALLER_ORG);
  });

  // ── S1: unrecognised origin throws at pipeline level ──

  it('S1: unrecognised origin throws at pipeline level', async () => {
    const { client } = buildMockSupabase();

    const input = {
      callerOrgId: CALLER_ORG,
      origin: 'mystery-origin',
      address: BASE_ADDRESS,
    } as unknown as ResolveOrCreateHouseInput;

    await expect(resolveOrCreateHouse(input, client)).rejects.toThrow("unrecognised origin 'mystery-origin'");
  });
});

// ---------------------------------------------------------------------------
// M1 regression: null-match-key same-label → dedup on synthesized key
// ---------------------------------------------------------------------------

describe('M1: null-match-key duplicate-house prevention', () => {
  it('(a) two null-match-key same-label calls → second call dedup-hits the first (ONE house)', async () => {
    // First call: no dedup hit, creates a house.
    const synthesizedKey = '42 trafalgar street, nelson 7010'; // normaliseAddress(ADDRESS_LABEL)

    const firstCallMock = buildMockSupabase({
      dedupResponse: { data: null },
      insertResponse: { data: { id: 'loc-first', name: ADDRESS_LABEL }, error: null },
    });

    const input: ResolveOrCreateHouseInput = {
      callerOrgId: CALLER_ORG,
      origin: 'contracted',
      address: { ...BASE_ADDRESS, addressMatchKey: null },
    };

    const result1 = await resolveOrCreateHouse(input, firstCallMock.client);
    expect(result1.action).toBe('created');
    expect(result1.locationId).toBe('loc-first');

    // Verify the insert was called with the synthesized key
    expect(firstCallMock.insertFn).toHaveBeenCalled();
    const insertedRow = firstCallMock.insertFn.mock.calls[0][0] as Record<string, unknown>;
    expect(insertedRow.address_match_key).toBe(synthesizedKey);

    // Second call: dedup finds the house created by the first call.
    const secondCallMock = buildMockSupabase({
      dedupResponse: {
        data: { id: 'loc-first', name: ADDRESS_LABEL, address: ADDRESS_LABEL, organization_id: CALLER_ORG },
      },
    });

    const result2 = await resolveOrCreateHouse(input, secondCallMock.client);
    expect(result2.action).toBe('existing');
    expect(result2.locationId).toBe('loc-first');
    expect(secondCallMock.insertFn).not.toHaveBeenCalled();
  });

  it('M1: dedup query uses the synthesized key (not null) when matchKey is null', async () => {
    const mock = buildMockSupabase({
      dedupResponse: { data: null },
      insertResponse: { data: { id: NEW_LOCATION_ID, name: ADDRESS_LABEL }, error: null },
    });

    const input: ResolveOrCreateHouseInput = {
      callerOrgId: CALLER_ORG,
      origin: 'contracted',
      address: { ...BASE_ADDRESS, addressMatchKey: null },
    };

    await resolveOrCreateHouse(input, mock.client);

    // The dedup select should have been called (from('locations') was called)
    expect(mock.fromFn).toHaveBeenCalledWith('locations');
    // And the select chain was invoked (dedup ran, not skipped)
    expect(mock.selectForDedupFn).toHaveBeenCalled();
  });

  it('M1: null matchKey AND null label → no dedup key, creates directly', async () => {
    const mock = buildMockSupabase({
      dedupResponse: { data: null },
      insertResponse: { data: { id: NEW_LOCATION_ID, name: 'Named House' }, error: null },
    });

    const input: ResolveOrCreateHouseInput = {
      callerOrgId: CALLER_ORG,
      origin: 'contracted',
      address: { addressMatchKey: null, label: null, lat: -41.27, lng: 173.28 },
      name: 'Named House',
    };

    const result = await resolveOrCreateHouse(input, mock.client);
    expect(result.action).toBe('created');
  });
});

// ---------------------------------------------------------------------------
// F1/F2 regression: dedup query error → throws, does NOT create
// ---------------------------------------------------------------------------

describe('F1: dedupHouseByMatchKey query error → throws (never treats failure as no-match)', () => {
  it('org-scoped dedup query error → throws, does NOT proceed to create', async () => {
    const mock = buildMockSupabase({
      dedupResponse: { data: null, error: { message: 'network timeout on locations' } },
      insertResponse: { data: { id: NEW_LOCATION_ID, name: ADDRESS_LABEL }, error: null },
    });

    const input: ResolveOrCreateHouseInput = {
      callerOrgId: CALLER_ORG,
      origin: 'contracted',
      address: BASE_ADDRESS,
    };

    await expect(resolveOrCreateHouse(input, mock.client)).rejects.toThrow(
      'dedupHouseByMatchKey: locations dedup query failed: network timeout on locations',
    );
    // Must NOT have attempted an insert
    expect(mock.insertFn).not.toHaveBeenCalled();
  });

  it('org-scoped dedup query RLS error → throws, does NOT create a duplicate', async () => {
    const mock = buildMockSupabase({
      dedupResponse: { data: null, error: { message: 'new row violates row-level security policy' } },
      insertResponse: { data: { id: NEW_LOCATION_ID, name: ADDRESS_LABEL }, error: null },
    });

    const input: ResolveOrCreateHouseInput = {
      callerOrgId: CALLER_ORG,
      origin: 'contracted',
      address: BASE_ADDRESS,
    };

    await expect(resolveOrCreateHouse(input, mock.client)).rejects.toThrow(
      'dedupHouseByMatchKey: locations dedup query failed',
    );
    expect(mock.insertFn).not.toHaveBeenCalled();
  });
});

describe('F2: cross-org M3 edge fn error → throws (never treats failure as no-conflict)', () => {
  it('edge fn invoke error → throws, does NOT silently pass M3 check', async () => {
    const mock = buildMockSupabase({
      placeOrgResponse: { data: { organization_id: PLACE_ORG }, error: null },
      dedupResponse: { data: null }, // no hit under correct org
      conflictCheckResponse: { data: null, error: { message: 'connection refused' } },
      insertResponse: { data: { id: NEW_LOCATION_ID, name: ADDRESS_LABEL }, error: null },
    });

    const input: ResolveOrCreateHouseInput = {
      callerOrgId: CALLER_ORG,
      origin: 'enforcement',
      address: BASE_ADDRESS,
      parcel: PARCEL,
    };

    await expect(resolveOrCreateHouse(input, mock.client)).rejects.toThrow(
      /cross-org M3 conflict check failed.*connection refused/,
    );
    // Must NOT have attempted an insert — the M3 check must fail loud
    expect(mock.insertFn).not.toHaveBeenCalled();
  });

  it('edge fn invoke timeout → throws, does NOT allow forked anchor', async () => {
    const mock = buildMockSupabase({
      placeOrgResponse: { data: { organization_id: PLACE_ORG }, error: null },
      dedupResponse: { data: null },
      conflictCheckResponse: { data: null, error: { message: 'statement timeout' } },
      insertResponse: { data: { id: NEW_LOCATION_ID, name: ADDRESS_LABEL }, error: null },
    });

    const input: ResolveOrCreateHouseInput = {
      callerOrgId: CALLER_ORG,
      origin: 'enforcement',
      address: BASE_ADDRESS,
      parcel: PARCEL,
    };

    await expect(resolveOrCreateHouse(input, mock.client)).rejects.toThrow(
      /cross-org M3 conflict check failed/,
    );
    expect(mock.insertFn).not.toHaveBeenCalled();
  });

  it('edge fn returns invalid response (no conflict field) → throws', async () => {
    const mock = buildMockSupabase({
      placeOrgResponse: { data: { organization_id: PLACE_ORG }, error: null },
      dedupResponse: { data: null },
      conflictCheckResponse: { data: { error: 'address_match_key is required' }, error: null },
      insertResponse: { data: { id: NEW_LOCATION_ID, name: ADDRESS_LABEL }, error: null },
    });

    const input: ResolveOrCreateHouseInput = {
      callerOrgId: CALLER_ORG,
      origin: 'enforcement',
      address: BASE_ADDRESS,
      parcel: PARCEL,
    };

    await expect(resolveOrCreateHouse(input, mock.client)).rejects.toThrow(
      /invalid response/,
    );
    expect(mock.insertFn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// M2 regression: same address under ordinary vs enforcement → different houses
// ---------------------------------------------------------------------------

describe('M2: org-aware dedup — same address, different origins', () => {
  it('(b) same address under ordinary vs enforcement → two DIFFERENT houses, no collision', async () => {
    // Ordinary call: house under caller org
    const ordinaryMock = buildMockSupabase({
      dedupResponse: { data: null },
      insertResponse: { data: { id: 'loc-ordinary', name: ADDRESS_LABEL }, error: null },
    });

    const ordinaryInput: ResolveOrCreateHouseInput = {
      callerOrgId: CALLER_ORG,
      origin: 'contracted',
      address: BASE_ADDRESS,
    };

    const ordinaryResult = await resolveOrCreateHouse(ordinaryInput, ordinaryMock.client);
    expect(ordinaryResult.action).toBe('created');
    expect(ordinaryResult.effectiveOwnerOrgId).toBe(CALLER_ORG);

    // Enforcement call: house under place-record org (different org)
    const enforcementMock = buildMockSupabase({
      placeOrgResponse: { data: { organization_id: PLACE_ORG }, error: null },
      dedupResponse: { data: null },
      insertResponse: { data: { id: 'loc-enforcement', name: ADDRESS_LABEL }, error: null },
    });

    const enforcementInput: ResolveOrCreateHouseInput = {
      callerOrgId: CALLER_ORG,
      origin: 'enforcement',
      address: BASE_ADDRESS,
      parcel: PARCEL,
    };

    const enforcementResult = await resolveOrCreateHouse(enforcementInput, enforcementMock.client);
    expect(enforcementResult.action).toBe('created');
    expect(enforcementResult.effectiveOwnerOrgId).toBe(PLACE_ORG);

    // The two houses are under DIFFERENT orgs — no collision
    expect(ordinaryResult.effectiveOwnerOrgId).not.toBe(enforcementResult.effectiveOwnerOrgId);
    expect(ordinaryResult.locationId).not.toBe(enforcementResult.locationId);
  });
});

// ---------------------------------------------------------------------------
// M3 regression: legacy wrong-org conflict → explicit stop/flag
// ---------------------------------------------------------------------------

describe('M3: legacy wrong-org conflict detection (via edge fn)', () => {
  it('(c) existing house with same address key but wrong org for enforcement → throws', async () => {
    // Edge fn returns conflict:true (officer-tier: no detail)
    const mock = buildMockSupabase({
      placeOrgResponse: { data: { organization_id: PLACE_ORG }, error: null },
      dedupResponse: { data: null }, // no house under the CORRECT org (PLACE_ORG)
      conflictCheckResponse: {
        data: { conflict: true },
      },
    });

    const input: ResolveOrCreateHouseInput = {
      callerOrgId: CALLER_ORG,
      origin: 'enforcement',
      address: BASE_ADDRESS,
      parcel: PARCEL,
    };

    await expect(resolveOrCreateHouse(input, mock.client)).rejects.toThrow(
      /legacy wrong-org conflict/,
    );
  });

  it('M3: officer-tier stops on conflict:true WITHOUT needing the org id', async () => {
    // Officer tier: conflict:true only, no conflict_org_id, no existing_location_id
    const mock = buildMockSupabase({
      placeOrgResponse: { data: { organization_id: PLACE_ORG }, error: null },
      dedupResponse: { data: null },
      conflictCheckResponse: {
        data: { conflict: true },
      },
    });

    const input: ResolveOrCreateHouseInput = {
      callerOrgId: CALLER_ORG,
      origin: 'enforcement',
      address: BASE_ADDRESS,
      parcel: PARCEL,
    };

    await expect(resolveOrCreateHouse(input, mock.client)).rejects.toThrow(
      /legacy wrong-org conflict/,
    );
    // Must NOT have attempted an insert
    expect(mock.insertFn).not.toHaveBeenCalled();
  });

  it('M3: admin-tier stops on conflict:true WITH full detail in error message', async () => {
    // Admin tier: conflict:true with conflict_org_id + existing_location_id
    const mock = buildMockSupabase({
      placeOrgResponse: { data: { organization_id: PLACE_ORG }, error: null },
      dedupResponse: { data: null },
      conflictCheckResponse: {
        data: {
          conflict: true,
          conflict_org_id: 'legacy-wrong-org-456',
          existing_location_id: 'loc-legacy-wrong',
        },
      },
    });

    const input: ResolveOrCreateHouseInput = {
      callerOrgId: CALLER_ORG,
      origin: 'enforcement',
      address: BASE_ADDRESS,
      parcel: PARCEL,
    };

    const err = await resolveOrCreateHouse(input, mock.client).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/legacy wrong-org conflict/);
    expect(err.message).toContain('legacy-wrong-org-456');
    expect(err.message).toContain('loc-legacy-wrong');
    expect(mock.insertFn).not.toHaveBeenCalled();
  });

  it('M3: no conflict when org-scoped dedup finds existing house under correct org (edge fn NOT invoked)', async () => {
    const mock = buildMockSupabase({
      placeOrgResponse: { data: { organization_id: PLACE_ORG }, error: null },
      dedupResponse: {
        data: { id: EXISTING_LOCATION_ID, name: ADDRESS_LABEL, address: ADDRESS_LABEL, organization_id: PLACE_ORG },
      },
    });

    const input: ResolveOrCreateHouseInput = {
      callerOrgId: CALLER_ORG,
      origin: 'enforcement',
      address: BASE_ADDRESS,
      parcel: PARCEL,
    };

    const result = await resolveOrCreateHouse(input, mock.client);
    expect(result.action).toBe('existing');
    expect(result.locationId).toBe(EXISTING_LOCATION_ID);
  });

  it('M3: no conflict when edge fn returns conflict:false → proceeds to create house', async () => {
    // Org-scoped dedup returns NO hit (data: null) → helper must invoke
    // check-house-conflict-any-org edge fn. Edge fn returns conflict:false
    // → helper proceeds to CREATE a new house.
    const mock = buildMockSupabase({
      placeOrgResponse: { data: { organization_id: PLACE_ORG }, error: null },
      dedupResponse: { data: null }, // no own-org dedup hit
      conflictCheckResponse: { data: { conflict: false }, error: null },
      insertResponse: { data: { id: NEW_LOCATION_ID, name: ADDRESS_LABEL }, error: null },
    });

    const input: ResolveOrCreateHouseInput = {
      callerOrgId: CALLER_ORG,
      origin: 'enforcement',
      address: BASE_ADDRESS,
      parcel: PARCEL,
    };

    const result = await resolveOrCreateHouse(input, mock.client);

    // The edge fn was actually invoked
    expect(mock.invokeFn).toHaveBeenCalledWith(
      'check-house-conflict-any-org',
      expect.objectContaining({
        body: {
          address_match_key: MATCH_KEY,
          effective_owner_org_id: PLACE_ORG,
        },
      }),
    );
    // Helper proceeded to create a new house
    expect(result.action).toBe('created');
    expect(result.locationId).toBe(NEW_LOCATION_ID);
    expect(result.effectiveOwnerOrgId).toBe(PLACE_ORG);
    expect(mock.insertFn).toHaveBeenCalled();
  });

  it('M3: ordinary origins do NOT trigger cross-org conflict check (no edge round-trip)', async () => {
    const mock = buildMockSupabase({
      dedupResponse: { data: null },
      insertResponse: { data: { id: NEW_LOCATION_ID, name: ADDRESS_LABEL }, error: null },
      // Even if the conflict check would return a conflict, ordinary origins
      // should never invoke it.
      conflictCheckResponse: {
        data: { conflict: true, conflict_org_id: 'other-org', existing_location_id: 'loc-other' },
      },
    });

    const input: ResolveOrCreateHouseInput = {
      callerOrgId: CALLER_ORG,
      origin: 'contracted',
      address: BASE_ADDRESS,
    };

    const result = await resolveOrCreateHouse(input, mock.client);
    expect(result.action).toBe('created');
    // Verify the edge fn was NOT invoked for ordinary origins
    expect(mock.invokeFn).not.toHaveBeenCalledWith(
      'check-house-conflict-any-org',
      expect.anything(),
    );
  });

  it('M3: enforcement invokes check-house-conflict-any-org edge fn with correct body', async () => {
    const mock = buildMockSupabase({
      placeOrgResponse: { data: { organization_id: PLACE_ORG }, error: null },
      dedupResponse: { data: null },
      conflictCheckResponse: { data: { conflict: false } },
      insertResponse: { data: { id: NEW_LOCATION_ID, name: ADDRESS_LABEL }, error: null },
    });

    const input: ResolveOrCreateHouseInput = {
      callerOrgId: CALLER_ORG,
      origin: 'enforcement',
      address: BASE_ADDRESS,
      parcel: PARCEL,
    };

    await resolveOrCreateHouse(input, mock.client);

    // Verify the edge fn was invoked with the correct function name and body
    expect(mock.invokeFn).toHaveBeenCalledWith(
      'check-house-conflict-any-org',
      expect.objectContaining({
        body: {
          address_match_key: MATCH_KEY,
          effective_owner_org_id: PLACE_ORG,
        },
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// M4 regression: enforcement resolution unavailable / role-denied → throws
// ---------------------------------------------------------------------------

describe('M4: enforcement resolution unavailable / role-denied', () => {
  it('(d) enforcement resolution denied → throws, never caller-org fallback', async () => {
    const { client } = buildMockSupabase({
      placeOrgResponse: {
        data: null,
        error: { message: 'Forbidden: caller lacks admin/master/grand_master role' },
      },
    });

    const input: ResolveOrCreateHouseInput = {
      callerOrgId: CALLER_ORG,
      origin: 'enforcement',
      address: BASE_ADDRESS,
      parcel: PARCEL,
    };

    await expect(resolveOrCreateHouse(input, client)).rejects.toThrow(
      /place-org resolution failed/,
    );
  });

  it('M4: enforcement error message names the role requirement', async () => {
    const { client } = buildMockSupabase({
      placeOrgResponse: {
        data: null,
        error: { message: 'Forbidden: insufficient role' },
      },
    });

    const input: ResolveOrCreateHouseInput = {
      callerOrgId: CALLER_ORG,
      origin: 'enforcement',
      address: BASE_ADDRESS,
      parcel: PARCEL,
    };

    await expect(resolveOrCreateHouse(input, client)).rejects.toThrow(
      /admin.*master.*grand_master/,
    );
  });

  it('M4: enforcement resolution unavailable → throws with NEVER degrades, never returns caller org', async () => {
    const { client } = buildMockSupabase({
      placeOrgResponse: {
        data: null,
        error: { message: 'Service unavailable' },
      },
    });

    const input: ResolveOrCreateHouseInput = {
      callerOrgId: CALLER_ORG,
      origin: 'enforcement',
      address: BASE_ADDRESS,
      parcel: PARCEL,
    };

    await expect(resolveOrCreateHouse(input, client)).rejects.toThrow('NEVER degrades');
  });
});

// ---------------------------------------------------------------------------
// (e) Idempotent reuse under identical resolved inputs (dedup hit)
// ---------------------------------------------------------------------------

describe('idempotent reuse (dedup hit)', () => {
  it('(e) identical inputs on second call → same locationId, action=existing', async () => {
    const mock = buildMockSupabase({
      dedupResponse: {
        data: { id: EXISTING_LOCATION_ID, name: ADDRESS_LABEL, address: ADDRESS_LABEL, organization_id: CALLER_ORG },
      },
    });

    const input: ResolveOrCreateHouseInput = {
      callerOrgId: CALLER_ORG,
      origin: 'contracted',
      address: BASE_ADDRESS,
    };

    const result = await resolveOrCreateHouse(input, mock.client);
    expect(result.locationId).toBe(EXISTING_LOCATION_ID);
    expect(result.action).toBe('existing');
    expect(result.effectiveOwnerOrgId).toBe(CALLER_ORG);
    expect(mock.insertFn).not.toHaveBeenCalled();
  });

  it('(e) idempotent reuse for enforcement origin', async () => {
    const mock = buildMockSupabase({
      placeOrgResponse: { data: { organization_id: PLACE_ORG }, error: null },
      dedupResponse: {
        data: { id: EXISTING_LOCATION_ID, name: ADDRESS_LABEL, address: ADDRESS_LABEL, organization_id: PLACE_ORG },
      },
    });

    const input: ResolveOrCreateHouseInput = {
      callerOrgId: CALLER_ORG,
      origin: 'enforcement',
      address: BASE_ADDRESS,
      parcel: PARCEL,
    };

    const result = await resolveOrCreateHouse(input, mock.client);
    expect(result.locationId).toBe(EXISTING_LOCATION_ID);
    expect(result.action).toBe('existing');
    expect(result.effectiveOwnerOrgId).toBe(PLACE_ORG);
    expect(mock.insertFn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Origin classification constants
// ---------------------------------------------------------------------------

describe('origin classification constants', () => {
  it('ENFORCEMENT_ORIGINS contains the expected origins', () => {
    expect(ENFORCEMENT_ORIGINS.has('enforcement')).toBe(true);
    expect(ENFORCEMENT_ORIGINS.has('noise')).toBe(true);
    expect(ENFORCEMENT_ORIGINS.has('biosecurity')).toBe(true);
    expect(ENFORCEMENT_ORIGINS.has('smoke')).toBe(true);
  });

  it('ORDINARY_ORIGINS contains the expected origins', () => {
    expect(ORDINARY_ORIGINS.has('contracted')).toBe(true);
    expect(ORDINARY_ORIGINS.has('alarm')).toBe(true);
    expect(ORDINARY_ORIGINS.has('adhoc')).toBe(true);
    expect(ORDINARY_ORIGINS.has('site-management')).toBe(true);
  });

  it('ENFORCEMENT and ORDINARY origins do not overlap', () => {
    for (const origin of ENFORCEMENT_ORIGINS) {
      expect(ORDINARY_ORIGINS.has(origin)).toBe(false);
    }
    for (const origin of ORDINARY_ORIGINS) {
      expect(ENFORCEMENT_ORIGINS.has(origin)).toBe(false);
    }
  });

  it('ALL_RECOGNISED_ORIGINS is the union of ENFORCEMENT + ORDINARY', () => {
    for (const origin of ENFORCEMENT_ORIGINS) {
      expect(ALL_RECOGNISED_ORIGINS.has(origin)).toBe(true);
    }
    for (const origin of ORDINARY_ORIGINS) {
      expect(ALL_RECOGNISED_ORIGINS.has(origin)).toBe(true);
    }
    expect(ALL_RECOGNISED_ORIGINS.size).toBe(ENFORCEMENT_ORIGINS.size + ORDINARY_ORIGINS.size);
  });
});
