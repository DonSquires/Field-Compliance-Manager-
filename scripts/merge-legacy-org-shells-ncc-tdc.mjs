#!/usr/bin/env node
// Merges legacy duplicate-provider NCC/TDC organization shells into the canonical
// R&M-facing organization rows. See docs/RM_ONBOARDING_TRACKER.md "Known gaps".
//
// Root cause: a prior pass modeled draft "First Security" / "Iron Eagle" prospecting
// relationships with Nelson City Council and Tasman District Council by creating a
// SEPARATE organizations row per provider relationship, instead of one canonical
// council org with multiple service_agreements (the schema already supports
// many-to-many via provider_organization_id + client_organization_id). Sites and
// zones are seats that belong to the client council regardless of which provider (if
// any) currently has an accepted agreement for them -- so real child data (sites,
// zones, draft agreements) belongs on the ONE canonical council org, not scattered
// across per-provider shells.
//
// Every client_sites / location_zones row "hangs off" a locations row (a "house"),
// which the zz_*_place_house triggers refuse to let a site/zone reference if the
// house's own organization_id differs from the site/zone's owner. Each of these 63
// houses is privately owned 1:1 by one of the 3 legacy shells (none shared with any
// other org), so the houses must be re-homed to the canonical org FIRST, before the
// sites/zones that reference them, or the triggers reject the update.
//
// This script:
//   1. Retargets the underlying locations ("house") rows to the canonical council org.
//   2. Retargets client_sites / location_zones / service_agreements (client side
//      only) from the legacy shells onto the canonical council org.
//   3. Resets client_sites.organization_id to the canonical org for rows that had
//      it incorrectly pre-assigned to a provider despite no accepted agreement
//      (matches the convention already used by rows that correctly have no
//      provider assignment: organization_id == client_organization_id).
//   4. Disambiguates the one literal name collision the merge creates.
//   5. Archives (renames, deactivates, hides from discovery) the now-empty legacy
//      shells rather than deleting them -- preserves audit history and the
//      already-archived provider-org FKs that reference them.
//   6. Deactivates two unrelated test-fixture user_profiles found attached to the
//      legacy shells.
//
// Usage: node scripts/merge-legacy-org-shells-ncc-tdc.mjs
// Requires SUPABASE_ACCESS_TOKEN (or FIELD_COMPLIANCE_CODESPACE) in the environment.

const token = process.env.SUPABASE_ACCESS_TOKEN || process.env.FIELD_COMPLIANCE_CODESPACE;
if (!token) throw new Error('SUPABASE_ACCESS_TOKEN / FIELD_COMPLIANCE_CODESPACE not set');
const PROJECT = 'dotczcyyzgabmtmnglqj';

async function sql(query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(json));
  return json;
}

const NCC_CANON = '405fc1f7-45e8-4736-a517-885bb3e5ef95';
const TDC_CANON = '54ade19f-0bb7-45ca-a32d-2d87214c4e77';
const NCC_LEGACY = ['fc4ca1c9-e606-4a93-b21b-da79274c7440', '7171d3c7-f820-483b-ba2d-122fe067b8a8'];
const TDC_LEGACY = ['6f59d817-a432-4401-b44e-896c32e2ea05'];
const ALL_LEGACY = [...NCC_LEGACY, ...TDC_LEGACY];

const q = (ids) => ids.map((id) => `'${id}'`).join(',');

async function main() {
  console.log('=== BEFORE: rows owned by legacy shells ===');
  console.log(JSON.stringify(await sql(`
    select 'client_sites' as t, count(*) from client_sites where client_organization_id in (${q(ALL_LEGACY)})
    union all select 'location_zones', count(*) from location_zones where organization_id in (${q(ALL_LEGACY)})
    union all select 'service_agreements', count(*) from service_agreements where client_organization_id in (${q(ALL_LEGACY)})
  `), null, 2));

  const migration = `
    begin;

    -- Re-home the houses first: the zz_*_place_house triggers reject a site/zone
    -- update if the house it references is still owned by a different org.
    update locations set organization_id = '${NCC_CANON}'
      where organization_id in (${q(NCC_LEGACY)});
    update locations set organization_id = '${TDC_CANON}'
      where organization_id in (${q(TDC_LEGACY)});

    update client_sites
      set client_organization_id = '${NCC_CANON}', organization_id = '${NCC_CANON}'
      where client_organization_id in (${q(NCC_LEGACY)});

    update client_sites
      set client_organization_id = '${TDC_CANON}', organization_id = '${TDC_CANON}'
      where client_organization_id in (${q(TDC_LEGACY)});

    update location_zones set organization_id = '${NCC_CANON}'
      where organization_id in (${q(NCC_LEGACY)});
    update location_zones set organization_id = '${TDC_CANON}'
      where organization_id in (${q(TDC_LEGACY)});

    update service_agreements set client_organization_id = '${NCC_CANON}'
      where client_organization_id in (${q(NCC_LEGACY)});
    update service_agreements set client_organization_id = '${TDC_CANON}'
      where client_organization_id in (${q(TDC_LEGACY)});

    update client_sites set name = 'Nelson City Council - Miller Acre (First Security prospect shell)'
      where id = 'adda0cba-066b-4907-849f-0ed00c63371b';
    update client_sites set name = 'Nelson City Council - Miller Acre (First Security draft proposal)'
      where id = '9504540f-fe48-4f8a-8daf-7ba07e941864';

    update organizations set
      name = name || ' (legacy shell -- merged into canonical org, see account_notes)',
      status = 'archived',
      active = false,
      discoverable = false,
      account_notes = coalesce(account_notes || E'\\n\\n', '') ||
        'Merged ' || now()::date || ': real child data (sites/zones/agreements) moved to canonical organization ' ||
        (case when id in (${q(NCC_LEGACY)}) then '${NCC_CANON}' else '${TDC_CANON}' end) ||
        '. This shell modeled a draft/not-invited provider relationship that duplicated the council identity. See docs/RM_ONBOARDING_TRACKER.md.'
      where id in (${q(ALL_LEGACY)});

    update user_profiles set deactivated_at = now()
      where email in ('test@test.com', 'finance-e2e-client@field-compliance.test')
      and deactivated_at is null;

    commit;
  `;

  console.log('=== RUNNING MIGRATION ===');
  await sql(migration);
  console.log('done');

  console.log('=== AFTER: legacy shells should be empty ===');
  console.log(JSON.stringify(await sql(`
    select 'client_sites' as t, count(*) from client_sites where client_organization_id in (${q(ALL_LEGACY)})
    union all select 'location_zones', count(*) from location_zones where organization_id in (${q(ALL_LEGACY)})
    union all select 'service_agreements', count(*) from service_agreements where client_organization_id in (${q(ALL_LEGACY)})
  `), null, 2));

  console.log('=== AFTER: canonical orgs now own the merged rows ===');
  console.log(JSON.stringify(await sql(`
    select 'client_sites(NCC)' as t, count(*) from client_sites where client_organization_id = '${NCC_CANON}'
    union all select 'client_sites(TDC)', count(*) from client_sites where client_organization_id = '${TDC_CANON}'
    union all select 'location_zones(NCC)', count(*) from location_zones where organization_id = '${NCC_CANON}'
    union all select 'location_zones(TDC)', count(*) from location_zones where organization_id = '${TDC_CANON}'
    union all select 'service_agreements(NCC)', count(*) from service_agreements where client_organization_id = '${NCC_CANON}'
    union all select 'service_agreements(TDC)', count(*) from service_agreements where client_organization_id = '${TDC_CANON}'
  `), null, 2));

  console.log('=== AFTER: legacy org shell status ===');
  console.log(JSON.stringify(await sql(`
    select id, name, status, active, discoverable from organizations where id in (${q(ALL_LEGACY)})
  `), null, 2));

  console.log('=== AFTER: test profiles deactivated? ===');
  console.log(JSON.stringify(await sql(`
    select email, deactivated_at from user_profiles
    where email in ('test@test.com', 'finance-e2e-client@field-compliance.test')
  `), null, 2));
}

main().catch((err) => { console.error(err); process.exit(1); });
