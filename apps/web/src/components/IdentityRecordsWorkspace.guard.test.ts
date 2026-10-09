import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workspace = readFileSync(
  resolve(process.cwd(), "src/components/IdentityRecordsWorkspace.tsx"),
  "utf8",
).replace(/\r\n/g, "\n");
const vehicleHistory = readFileSync(
  resolve(process.cwd(), "src/components/RepeatSubjectsPanel.tsx"),
  "utf8",
).replace(/\r\n/g, "\n");
const flagMigration = readFileSync(
  resolve(process.cwd(), "../../supabase/migrations/20260916100000_safety_warnings_and_plate_registry_read.sql"),
  "utf8",
);

describe("identity person-of-interest workflow", () => {
  it("persists the NZTA source checkbox as historical provenance, not authority", () => {
    expect(workspace).toContain('name="nzta_mvr_sourced"');
    expect(workspace).toContain("checked={person.nzta_mvr_sourced}");
    expect(workspace).toContain("Historical provenance only");
    expect(workspace).toContain('detail.nzta_mvr_sourced === true');
  });

  it("flags only verified canonical people through the scoped audited RPC", () => {
    expect(workspace).toContain('selectedPerson?.review_state === "verified"');
    expect(workspace).toContain('selectedPerson.canonical_review_state === "verified"');
    expect(workspace).toContain('"organization_id", organizationId');
    expect(workspace).toContain('"raise_scoped_person_interest_flag"');
    expect(workspace).toContain("p_organization_id: organizationId");
    expect(workspace).toContain('supabase.rpc("resolve_entity_flag"');
    expect(workspace).toContain("p_reason: personInterestReason.trim()");
    expect(workspace).toContain('minLength={5}');
    expect(flagMigration).toContain("entity_flag_raised");
    expect(flagMigration).toContain("entity_flag_resolved");
  });

  it("keeps person-to-vehicle identification on the verified, reasoned observation link", () => {
    expect(vehicleHistory).toContain('"list_verified_person_projections_for_organization"');
    expect(vehicleHistory).toContain('"link_observation_entities"');
    expect(vehicleHistory).toContain("p_identity_basis: basis.trim()");
    expect(vehicleHistory).toContain("minLength={5}");
    expect(vehicleHistory).toContain("organisation-scoped and audit-logged");
  });
});