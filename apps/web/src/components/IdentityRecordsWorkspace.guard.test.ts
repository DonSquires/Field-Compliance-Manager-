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
const approvedVehicleMigration = readFileSync(
  resolve(process.cwd(), "../../supabase/migrations/20261010213204_promote_approved_vehicle_mentions.sql"),
  "utf8",
);

describe("identity person-of-interest workflow", () => {
  it("persists the NZTA source checkbox as historical provenance, not authority", () => {
    expect(workspace).toContain('name="nzta_mvr_sourced"');
    expect(workspace).toContain("checked={person.nzta_mvr_sourced}");
    expect(workspace).toContain("Historical provenance only");
    expect(workspace).toContain('detail.nzta_mvr_sourced === true');
  });

  it("requires human source comparison before promoting an NZTA person-vehicle check", () => {
    expect(workspace).toContain('"nzta_mvr_record"');
    expect(workspace).toContain('"review_nzta_mvr_identity_evidence"');
    expect(workspace).toContain("person_vehicle_match_confirmed");
    expect(workspace).toContain('"get_vehicle_identity_checks"');
    expect(workspace).toContain("Open linked person");
    expect(workspace).toContain("Open private NZTA source");
    expect(workspace).toContain(
      "This is not proof of ownership; current",
    );
  });

  it("never prefills the NZTA page heading as the reviewed owner's name", () => {
    expect(workspace).toContain(
      "const NZTA_HEADING_NAME = /^\\s*details\\s*\\(\\s*\\d+\\s+registered\\s+persons?\\s*\\)\\s*$/i;",
    );
    expect(workspace).toContain(
      'if (NZTA_HEADING_NAME.test(String(values.display_name ?? "")))\n    delete values.display_name;',
    );
    expect(workspace).toContain(
      'if (NZTA_HEADING_NAME.test(form.display_name ?? "")) form.display_name = "";',
    );
  });

  it("shows approved working-file observations and private photos on canonical vehicles", () => {
    expect(workspace).toContain('"get_identity_vehicle_activity"');
    expect(workspace).toContain("Approved observation history");
    expect(workspace).toContain("Human-authored patrol records and CCTV review notes are");
    expect(workspace).toContain("vehicleActivityUrls");
    expect(workspace).toContain("canonical vehicles");
    expect(approvedVehicleMigration).toContain("promote_approved_rnm_vehicle_mentions");
    expect(approvedVehicleMigration).toContain("'approved_in_working_file'");
    expect(approvedVehicleMigration).toContain("'rm_approved_note_plate:'");
    expect(approvedVehicleMigration).toContain(
      "observation.canonical_vehicle_id = vehicle.id",
    );
    expect(approvedVehicleMigration).toContain("get_identity_vehicle_activity");
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

  it("shows the governed incident readback before and after linking a person", () => {
    expect(workspace).toContain('"get_incident_people"');
    expect(workspace).toContain("People already linked");
    expect(workspace).toContain("linkedPerson.involvement_role");
    expect(workspace).toContain("linkedPerson.source_kind");
    expect(workspace).toContain("linkedPerson.review_state");
    expect(workspace).toContain("await loadIncidentPeople(incidentId)");
    expect(workspace).toContain("requestId !== incidentPeopleRequest.current");
    expect(workspace).toContain("Could not load incident people:");
  });
});