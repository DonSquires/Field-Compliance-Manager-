import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  AlertTriangle,
  Car,
  CheckCircle2,
  FileBadge,
  Loader2,
  Plus,
  Save,
  Search,
  ShieldCheck,
  Trash2,
  Upload,
  UserRound,
  X,
} from "lucide-react";
import { supabase } from "../lib/supabase";
import "./IdentityRecordsWorkspace.css";

type PersonRecord = {
  person_record_id: string;
  canonical_person_id: string | null;
  display_name: string | null;
  review_state: string;
  profile_details: Record<string, unknown>;
  date_of_birth: string | null;
  canonical_review_state: string | null;
  face_candidate_ready: boolean;
  document_count: number;
};

type VehicleRecord = {
  id: string;
  plate_number: string;
  make: string | null;
  model: string | null;
  year: number | null;
  colour: string | null;
  body_type: string | null;
  rego_expiry: string | null;
  wof_expiry: string | null;
  cof_expiry: string | null;
  notes: string | null;
};

type IdentityDocument = {
  id: string;
  person_record_id: string;
  attachment_id: string | null;
  document_kind: string;
  extracted_fields: {
    proposed?: Record<string, unknown>;
    approved?: Record<string, unknown>;
    promoted_to_current_profile?: boolean;
    face_count?: number;
    candidate_matches?: Array<{
      match_id: string;
      display_name: string | null;
      score: number;
      basis: string;
    }>;
  };
  review_state: string;
  review_notes: string | null;
  created_at: string;
  file_name: string | null;
  file_type: string | null;
  storage_bucket: string | null;
  storage_path: string | null;
};

type Registry = {
  people: PersonRecord[];
  vehicles: VehicleRecord[];
  documents: IdentityDocument[];
};
type Mode = "people" | "vehicles";
type PersonForm = {
  display_name: string;
  date_of_birth: string;
  category: string;
  email: string;
  phone: string;
  address: string;
  driver_licence_number: string;
  driver_licence_expiry: string;
  firearms_licence_number: string;
  firearms_licence_expiry: string;
  security_licence_number: string;
  security_licence_expiry: string;
  security_licence_authority: string;
  security_endorsements: string;
  notes: string;
};
type VehicleForm = {
  plate_number: string;
  make: string;
  model: string;
  year: string;
  colour: string;
  body_type: string;
  rego_expiry: string;
  wof_expiry: string;
  cof_expiry: string;
  notes: string;
};

const EMPTY_PERSON: PersonForm = {
  display_name: "",
  date_of_birth: "",
  category: "",
  email: "",
  phone: "",
  address: "",
  driver_licence_number: "",
  driver_licence_expiry: "",
  firearms_licence_number: "",
  firearms_licence_expiry: "",
  security_licence_number: "",
  security_licence_expiry: "",
  security_licence_authority: "",
  security_endorsements: "",
  notes: "",
};
const EMPTY_VEHICLE: VehicleForm = {
  plate_number: "",
  make: "",
  model: "",
  year: "",
  colour: "",
  body_type: "",
  rego_expiry: "",
  wof_expiry: "",
  cof_expiry: "",
  notes: "",
};
const DOCUMENT_KINDS = [
  ["driver_licence", "Driver licence"],
  ["firearms_licence", "Firearms licence"],
  ["security_licence", "Security licence / CoA"],
  ["passport", "Passport"],
  ["national_id", "Other government ID"],
  ["person_photo", "Person reference photo"],
  ["other_identity", "Other identity evidence"],
] as const;

function words(value: string) {
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function personForm(person: PersonRecord): PersonForm {
  const detail = person.profile_details ?? {};
  const value = (key: string) =>
    typeof detail[key] === "string" ? String(detail[key]) : "";
  return {
    display_name: person.display_name ?? "",
    date_of_birth: person.date_of_birth ?? "",
    category: value("category"),
    email: value("email"),
    phone: value("phone"),
    address: value("address"),
    driver_licence_number: value("driver_licence_number"),
    driver_licence_expiry: value("driver_licence_expiry"),
    firearms_licence_number: value("firearms_licence_number"),
    firearms_licence_expiry: value("firearms_licence_expiry"),
    security_licence_number: value("security_licence_number"),
    security_licence_expiry: value("security_licence_expiry"),
    security_licence_authority: value("security_licence_authority"),
    security_endorsements: value("security_endorsements"),
    notes: value("notes"),
  };
}

function proposedPersonForm(
  current: PersonForm,
  proposed: Record<string, unknown>,
  documentKind: string,
): PersonForm {
  const values = Object.fromEntries(
    Object.entries(proposed).filter(([, value]) => typeof value === "string"),
  );
  if (typeof proposed.expiry_date === "string") {
    if (documentKind === "driver_licence")
      values.driver_licence_expiry = proposed.expiry_date;
    if (documentKind === "firearms_licence")
      values.firearms_licence_expiry = proposed.expiry_date;
    if (documentKind === "security_licence")
      values.security_licence_expiry = proposed.expiry_date;
  }
  return { ...current, ...values } as PersonForm;
}

function vehicleForm(vehicle: VehicleRecord): VehicleForm {
  return {
    plate_number: vehicle.plate_number,
    make: vehicle.make ?? "",
    model: vehicle.model ?? "",
    year: vehicle.year?.toString() ?? "",
    colour: vehicle.colour ?? "",
    body_type: vehicle.body_type ?? "",
    rego_expiry: vehicle.rego_expiry ?? "",
    wof_expiry: vehicle.wof_expiry ?? "",
    cof_expiry: vehicle.cof_expiry ?? "",
    notes: vehicle.notes ?? "",
  };
}

export function IdentityRecordsWorkspace({
  organizationId,
  userId,
  onClose,
}: {
  organizationId: string;
  userId: string;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<Mode>("people");
  const [registry, setRegistry] = useState<Registry>({
    people: [],
    vehicles: [],
    documents: [],
  });
  const [search, setSearch] = useState("");
  const [selectedPersonId, setSelectedPersonId] = useState<string | null>(null);
  const [selectedVehicleId, setSelectedVehicleId] = useState<string | null>(
    null,
  );
  const [person, setPerson] = useState<PersonForm>(EMPTY_PERSON);
  const [vehicle, setVehicle] = useState<VehicleForm>(EMPTY_VEHICLE);
  const [reason, setReason] = useState("");
  const [documentKind, setDocumentKind] = useState("driver_licence");
  const [documentFiles, setDocumentFiles] = useState<File[]>([]);
  const [documentInputKey, setDocumentInputKey] = useState(0);
  const [selectedDocument, setSelectedDocument] =
    useState<IdentityDocument | null>(null);
  const [documentFields, setDocumentFields] =
    useState<PersonForm>(EMPTY_PERSON);
  const [documentReviewNote, setDocumentReviewNote] = useState("");
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(
    async (term = "") => {
      setLoading(true);
      setError(null);
      const { data, error: loadError } = await supabase.rpc(
        "get_identity_registry",
        {
          p_organization_id: organizationId,
          p_search: term.trim() || null,
          p_limit: 150,
        },
      );
      if (loadError) setError(loadError.message);
      else {
        const value = data as Partial<Registry> | null;
        const nextRegistry = {
          people: value?.people ?? [],
          vehicles: value?.vehicles ?? [],
          documents: value?.documents ?? [],
        };
        setRegistry(nextRegistry);
        setLoading(false);
        return nextRegistry;
      }
      setLoading(false);
      return null;
    },
    [organizationId],
  );

  useEffect(() => {
    void load("");
  }, [load]);

  const selectPerson = (record: PersonRecord | null) => {
    setSelectedPersonId(record?.person_record_id ?? null);
    setPerson(record ? personForm(record) : EMPTY_PERSON);
    setReason("");
    setSelectedDocument(null);
    setDocumentFields(EMPTY_PERSON);
    setSourceUrl(null);
  };

  const selectVehicle = (record: VehicleRecord | null) => {
    setSelectedVehicleId(record?.id ?? null);
    setVehicle(record ? vehicleForm(record) : EMPTY_VEHICLE);
    setReason("");
  };

  const savePerson = async (event: FormEvent) => {
    event.preventDefault();
    setBusy("person");
    setError(null);
    setNotice(null);
    const { data: savedPerson, error: saveError } = await supabase.rpc(
      "manage_identity_person_record",
      {
        p_organization_id: organizationId,
        p_person_record_id: selectedPersonId,
        p_action: selectedPersonId ? "update" : "create",
        p_fields: person,
        p_reason: reason.trim(),
      },
    );
    if (saveError) setError(saveError.message);
    else {
      setNotice(
        selectedPersonId
          ? "Person record updated with audit history."
          : "Draft person record created.",
      );
      setReason("");
      const nextRegistry = await load(search);
      const savedRecord = nextRegistry?.people.find(
        (record) => record.person_record_id === savedPerson?.person_record_id,
      );
      if (savedRecord) selectPerson(savedRecord);
    }
    setBusy(null);
  };

  const retireFaceCandidates = async () => {
    if (!selectedPersonId || !reason.trim()) return;
    setBusy("retire-faces");
    setError(null);
    setNotice(null);
    const { error: retireError } = await supabase.rpc(
      "manage_identity_person_record",
      {
        p_organization_id: organizationId,
        p_person_record_id: selectedPersonId,
        p_action: "retire_faces",
        p_fields: {},
        p_reason: reason.trim(),
      },
    );
    if (retireError) setError(retireError.message);
    else {
      setNotice("Face candidates removed. The reason remains in audit history.");
      setReason("");
      await load(search);
    }
    setBusy(null);
  };

  const saveVehicle = async (event: FormEvent) => {
    event.preventDefault();
    setBusy("vehicle");
    setError(null);
    setNotice(null);
    const { error: saveError } = await supabase.rpc("manage_identity_vehicle", {
      p_organization_id: organizationId,
      p_vehicle_id: selectedVehicleId,
      p_plate: vehicle.plate_number,
      p_fields: vehicle,
      p_reason: reason.trim(),
    });
    if (saveError) setError(saveError.message);
    else {
      setNotice(
        selectedVehicleId
          ? "Vehicle record updated with audit history."
          : "Canonical vehicle created.",
      );
      setReason("");
      await load(search);
    }
    setBusy(null);
  };

  const conversationId = async () => {
    const existing = await supabase
      .from("bob_conversations")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("user_id", userId)
      .eq("module_key", "operations")
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (existing.error) throw existing.error;
    if (existing.data?.id) return existing.data.id;
    const created = await supabase
      .from("bob_conversations")
      .insert({
        organization_id: organizationId,
        user_id: userId,
        module_key: "operations",
        title: "Identity evidence intake",
      })
      .select("id")
      .single();
    if (created.error) throw created.error;
    return created.data.id;
  };

  const uploadDocument = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedPersonId || documentFiles.length === 0) return;
    setBusy("document");
    setError(null);
    setNotice(null);
    const oversized = documentFiles.find((file) => file.size > 25 * 1024 * 1024);
    if (oversized) {
      setError(`${oversized.name} is larger than 25 MB. Choose a smaller source file.`);
      setBusy(null);
      return;
    }
    const completed: Array<{ attachmentId: string; proposed: Record<string, unknown>; faceCount: number }> = [];
    const failures: string[] = [];
    try {
      const convId = await conversationId();
      for (const file of documentFiles) {
        const attachmentId = crypto.randomUUID();
        const safeName = file.name.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(-180);
        const storagePath = `org/${organizationId}/identity/${userId}/${attachmentId}-${safeName}`;
        let metadataRegistered = false;
        try {
          const upload = await supabase.storage.from("identity-evidence").upload(storagePath, file, {
            contentType: file.type || "application/octet-stream",
            upsert: false,
          });
          if (upload.error) throw upload.error;
          const metadata = await supabase.from("bob_attachments").insert({
            id: attachmentId,
            organization_id: organizationId,
            conversation_id: convId,
            uploaded_by: userId,
            file_name: file.name,
            file_type: file.type || "application/octet-stream",
            file_size_bytes: file.size,
            storage_bucket: "identity-evidence",
            storage_path: storagePath,
            purpose: "identity_document",
            processing_state: "processing",
          });
          if (metadata.error) throw metadata.error;
          metadataRegistered = true;
          const perception = await supabase.functions.invoke("bob-perceive-image", {
            body: {
              mode: "identity_document",
              attachment_id: attachmentId,
              organization_id: organizationId,
              person_record_id: selectedPersonId,
              document_kind: documentKind,
            },
          });
          if (perception.error || !perception.data?.success) {
            throw perception.error ?? new Error(perception.data?.error || "Identity extraction failed");
          }
          completed.push({
            attachmentId,
            proposed: perception.data.proposed_fields ?? {},
            faceCount: perception.data.face?.count ?? 0,
          });
        } catch (uploadError) {
          if (metadataRegistered) {
            await supabase.from("bob_attachments").update({ processing_state: "failed" }).eq("id", attachmentId).eq("uploaded_by", userId);
          } else {
            await supabase.storage.from("identity-evidence").remove([storagePath]);
          }
          failures.push(`${file.name}: ${uploadError instanceof Error ? uploadError.message : "extraction failed"}`);
        }
      }

      setDocumentFiles([]);
      setDocumentInputKey((value) => value + 1);
      const next = await load(search);
      const document = next?.documents?.find((item) => completed.some((result) => result.attachmentId === item.attachment_id)) ?? null;
      if (completed[0]) setDocumentFields(proposedPersonForm(person, completed[0].proposed, documentKind));
      if (document) await selectIdentityDocument(document);
      const faceReady = completed.filter((result) => result.faceCount === 1).length;
      if (completed.length) {
        setNotice(`${completed.length} source file${completed.length === 1 ? "" : "s"} ready for human review.${faceReady ? ` ${faceReady} contain one source face that can become a candidate after approval.` : " No enrolment face was found."}`);
      }
      if (failures.length) setError(`${failures.length} source file${failures.length === 1 ? "" : "s"} failed. ${failures.join(" ")}`);
    } finally {
      setBusy(null);
    }
  };

  const selectIdentityDocument = async (document: IdentityDocument) => {
    setSelectedDocument(document);
    setDocumentReviewNote("");
    const proposed =
      document.extracted_fields?.approved ??
      document.extracted_fields?.proposed ??
      {};
    setDocumentFields(
      proposedPersonForm(person, proposed, document.document_kind),
    );
    setSourceUrl(null);
    if (document.storage_bucket && document.storage_path) {
      const signed = await supabase.storage
        .from(document.storage_bucket)
        .createSignedUrl(document.storage_path, 600);
      if (!signed.error) setSourceUrl(signed.data.signedUrl);
    }
  };

  const reviewDocument = async (action: "approve" | "reject") => {
    if (!selectedDocument) return;
    setBusy(`review-${action}`);
    setError(null);
    setNotice(null);
    const { data: reviewResult, error: reviewError } = await supabase.rpc(
      "review_identity_evidence",
      {
        p_identity_document_id: selectedDocument.id,
        p_action: action,
        p_approved_fields: action === "approve" ? documentFields : {},
        p_review_notes: documentReviewNote.trim(),
      },
    );
    if (reviewError) setError(reviewError.message);
    else {
      setNotice(
        action === "approve"
          ? `Identity evidence approved.${reviewResult?.identity_verified ? " Identity details are verified." : " This evidence type does not verify identity details."}${["driver_licence", "firearms_licence", "security_licence"].includes(selectedDocument.document_kind) ? reviewResult?.current_credential_updated ? " Current licence details were updated." : " Historical licence retained without replacing current details." : ""}${reviewResult?.face_candidate_enrolled ? " One face candidate is now active." : " No face candidate was enrolled."}`
          : "Identity evidence rejected. Its face template was removed.",
      );
      setSelectedDocument(null);
      setSourceUrl(null);
      await load(search);
    }
    setBusy(null);
  };

  const personDocuments = registry.documents.filter(
    (document) => document.person_record_id === selectedPersonId,
  );
  const selectedPerson = registry.people.find(
    (record) => record.person_record_id === selectedPersonId,
  );

  return (
    <div className="identity-records-backdrop">
      <section
        className="identity-records"
        role="dialog"
        aria-modal="true"
        aria-labelledby="identity-records-title"
      >
        <header>
          <div>
            <span>People &amp; Access</span>
            <h2 id="identity-records-title">Identity records</h2>
            <p>
              Manually maintain people and vehicles, or review fields extracted
              from private identity evidence.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close identity records"
          >
            <X size={18} />
          </button>
        </header>
        <div className="identity-records-warning">
          <ShieldCheck size={17} />
          <span>
            Names, licence details and face templates are personal information.
            Extraction is advisory; approval is always a human decision.
          </span>
        </div>
        {error && (
          <div className="identity-records-message is-error" role="alert">
            <AlertTriangle size={16} />
            {error}
          </div>
        )}
        {notice && (
          <div className="identity-records-message is-success" role="status">
            <CheckCircle2 size={16} />
            {notice}
          </div>
        )}
        <div className="identity-records-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "people"}
            onClick={() => setMode("people")}
          >
            <UserRound size={16} />
            People
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "vehicles"}
            onClick={() => setMode("vehicles")}
          >
            <Car size={16} />
            Vehicles
          </button>
        </div>
        <form
          className="identity-records-search"
          onSubmit={(event) => {
            event.preventDefault();
            void load(search);
          }}
        >
          <Search size={16} />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={`Search ${mode}`}
          />
          <button type="submit">Search</button>
        </form>
        <div className="identity-records-layout">
          <aside className="identity-records-list">
            <button
              type="button"
              className="identity-records-add"
              onClick={() =>
                mode === "people" ? selectPerson(null) : selectVehicle(null)
              }
            >
              <Plus size={15} />
              Add {mode === "people" ? "person" : "vehicle"}
            </button>
            {loading ? (
              <p>
                <Loader2 size={15} className="is-spinning" /> Loading identity
                records
              </p>
            ) : mode === "people" ? (
              registry.people.map((record) => (
                <button
                  type="button"
                  key={record.person_record_id}
                  className={
                    selectedPersonId === record.person_record_id
                      ? "is-selected"
                      : ""
                  }
                  onClick={() => selectPerson(record)}
                >
                  <strong>{record.display_name || "Unnamed person"}</strong>
                  <small>
                    {words(record.review_state)} · {record.document_count}{" "}
                    document{record.document_count === 1 ? "" : "s"}
                    {registry.documents.filter(
                      (document) =>
                        document.person_record_id === record.person_record_id &&
                        document.review_state === "manual_review_required",
                    ).length
                      ? ` · ${registry.documents.filter((document) => document.person_record_id === record.person_record_id && document.review_state === "manual_review_required").length} review required`
                      : ""}
                    {record.face_candidate_ready
                      ? " · Face candidate ready"
                      : ""}
                  </small>
                </button>
              ))
            ) : (
              registry.vehicles.map((record) => (
                <button
                  type="button"
                  key={record.id}
                  className={
                    selectedVehicleId === record.id ? "is-selected" : ""
                  }
                  onClick={() => selectVehicle(record)}
                >
                  <strong>{record.plate_number}</strong>
                  <small>
                    {[record.make, record.model, record.colour]
                      .filter(Boolean)
                      .join(" · ") || "Details not recorded"}
                  </small>
                </button>
              ))
            )}
            {!loading && mode === "people" && registry.people.length === 0 && (
              <p>No people match this search. Add a person to begin.</p>
            )}
            {!loading && mode === "vehicles" && registry.vehicles.length === 0 && (
              <p>No vehicles match this search. Add a vehicle to begin.</p>
            )}
          </aside>
          <main className="identity-records-editor">
            {mode === "people" ? (
              <>
                <form onSubmit={savePerson}>
                  <h3>
                    1. {selectedPersonId ? "Person details" : "Add person"}
                  </h3>
                  <div className="identity-records-fields">
                    <label>
                      <span>Name</span>
                      <input
                        required
                        value={person.display_name}
                        onChange={(event) =>
                          setPerson({
                            ...person,
                            display_name: event.target.value,
                          })
                        }
                      />
                    </label>
                    <label>
                      <span>Date of birth</span>
                      <input
                        type="date"
                        value={person.date_of_birth}
                        onChange={(event) =>
                          setPerson({
                            ...person,
                            date_of_birth: event.target.value,
                          })
                        }
                      />
                    </label>
                    <label>
                      <span>Category</span>
                      <input
                        value={person.category}
                        onChange={(event) =>
                          setPerson({ ...person, category: event.target.value })
                        }
                        placeholder="Visitor, permit holder, person of interest…"
                      />
                    </label>
                    <label>
                      <span>Email</span>
                      <input
                        type="email"
                        value={person.email}
                        onChange={(event) =>
                          setPerson({ ...person, email: event.target.value })
                        }
                      />
                    </label>
                    <label>
                      <span>Phone</span>
                      <input
                        value={person.phone}
                        onChange={(event) =>
                          setPerson({ ...person, phone: event.target.value })
                        }
                      />
                    </label>
                    <label>
                      <span>Address</span>
                      <input
                        value={person.address}
                        onChange={(event) =>
                          setPerson({ ...person, address: event.target.value })
                        }
                      />
                    </label>
                    <label>
                      <span>Driver licence number</span>
                      <input
                        value={person.driver_licence_number}
                        onChange={(event) =>
                          setPerson({
                            ...person,
                            driver_licence_number: event.target.value,
                          })
                        }
                      />
                    </label>
                    <label>
                      <span>Firearms licence number</span>
                      <input
                        value={person.firearms_licence_number}
                        onChange={(event) =>
                          setPerson({
                            ...person,
                            firearms_licence_number: event.target.value,
                          })
                        }
                      />
                    </label>
                    <label>
                      <span>Driver licence expiry</span>
                      <input
                        type="date"
                        value={person.driver_licence_expiry}
                        onChange={(event) =>
                          setPerson({
                            ...person,
                            driver_licence_expiry: event.target.value,
                          })
                        }
                      />
                    </label>
                    <label>
                      <span>Firearms licence expiry</span>
                      <input
                        type="date"
                        value={person.firearms_licence_expiry}
                        onChange={(event) =>
                          setPerson({
                            ...person,
                            firearms_licence_expiry: event.target.value,
                          })
                        }
                      />
                    </label>
                    <label>
                      <span>Security licence / CoA number</span>
                      <input
                        value={person.security_licence_number}
                        onChange={(event) =>
                          setPerson({
                            ...person,
                            security_licence_number: event.target.value,
                          })
                        }
                      />
                    </label>
                    <label>
                      <span>Security licence / CoA expiry</span>
                      <input
                        type="date"
                        value={person.security_licence_expiry}
                        onChange={(event) =>
                          setPerson({
                            ...person,
                            security_licence_expiry: event.target.value,
                          })
                        }
                      />
                    </label>
                    <label>
                      <span>Security licence authority</span>
                      <input
                        value={person.security_licence_authority}
                        onChange={(event) =>
                          setPerson({
                            ...person,
                            security_licence_authority: event.target.value,
                          })
                        }
                      />
                    </label>
                    <label>
                      <span>Security endorsements</span>
                      <input
                        value={person.security_endorsements}
                        onChange={(event) =>
                          setPerson({
                            ...person,
                            security_endorsements: event.target.value,
                          })
                        }
                      />
                    </label>
                    <label className="is-wide">
                      <span>Notes</span>
                      <textarea
                        rows={3}
                        value={person.notes}
                        onChange={(event) =>
                          setPerson({ ...person, notes: event.target.value })
                        }
                      />
                    </label>
                    <label className="is-wide">
                      <span>Reason for change</span>
                      <textarea
                        required
                        rows={2}
                        value={reason}
                        onChange={(event) => setReason(event.target.value)}
                        placeholder="Required: why is this record changing?"
                      />
                    </label>
                  </div>
                  <div className="identity-record-actions">
                    <button
                      type="submit"
                      className="identity-records-primary"
                      disabled={
                        busy !== null ||
                        !person.display_name.trim() ||
                        !reason.trim()
                      }
                    >
                      <Save size={15} />
                      {busy === "person" ? "Saving" : "Save person"}
                    </button>
                    {selectedPerson?.face_candidate_ready && (
                      <button
                        type="button"
                        className="identity-records-danger"
                        onClick={() => void retireFaceCandidates()}
                        disabled={busy !== null || !reason.trim()}
                        title={
                          reason.trim()
                            ? "Remove this person's face candidates"
                            : "Enter the reason for change first"
                        }
                      >
                        <Trash2 size={15} />
                        {busy === "retire-faces"
                          ? "Removing"
                          : "Remove face candidate"}
                      </button>
                    )}
                  </div>
                </form>
                {selectedPersonId && (
                  <section className="identity-documents">
                    <h3>2. Identity evidence</h3>
                    <p>
                      Upload a clear image or PDF. OCR and face detection fill a
                      proposal; compare it with the source before approval.
                    </p>
                    {documentKind === "security_licence" && (
                      <p className="identity-records-guidance">
                        This records identity evidence and face matching only.
                        For an employee, record the approved CoA in People &amp;
                        HR → Credentials to update work readiness.
                      </p>
                    )}
                    <form onSubmit={uploadDocument}>
                      <label>
                        <span>Evidence type</span>
                        <select
                          value={documentKind}
                          onChange={(event) =>
                            setDocumentKind(event.target.value)
                          }
                        >
                          {DOCUMENT_KINDS.map(([value, label]) => (
                            <option value={value} key={value}>
                              {label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        <span>Source files</span>
                        <input
                          key={documentInputKey}
                          type="file"
                          required
                          multiple
                          accept="image/jpeg,image/png,image/webp,image/bmp,image/tiff,application/pdf"
                          onChange={(event) =>
                            setDocumentFiles(Array.from(event.target.files ?? []))
                          }
                        />
                      </label>
                      <button
                        type="submit"
                        disabled={busy !== null || documentFiles.length === 0}
                      >
                        <Upload size={15} />
                        {busy === "document"
                          ? "Reading evidence"
                          : documentFiles.length > 1
                            ? `Upload and extract ${documentFiles.length} files`
                            : "Upload and extract"}
                      </button>
                    </form>
                    <div className="identity-document-list">
                      {personDocuments.map((document) => (
                        <button
                          type="button"
                          key={document.id}
                          onClick={() => void selectIdentityDocument(document)}
                        >
                          <FileBadge size={15} />
                          <span>
                            <strong>
                              {DOCUMENT_KINDS.find(
                                ([value]) => value === document.document_kind,
                              )?.[1] ?? words(document.document_kind)}
                            </strong>
                            <small>
                              {document.file_name ?? "Source file"} ·{" "}
                              {document.review_state === "approved" &&
                              document.extracted_fields.promoted_to_current_profile === false
                                ? "Historical evidence · Current details unchanged"
                                : words(document.review_state)}
                            </small>
                          </span>
                        </button>
                      ))}
                      {personDocuments.length === 0 && (
                        <p>No identity evidence recorded yet.</p>
                      )}
                    </div>
                  </section>
                )}
              </>
            ) : (
              <form onSubmit={saveVehicle}>
                <h3>{selectedVehicleId ? "Vehicle details" : "Add vehicle"}</h3>
                <div className="identity-records-fields">
                  <label>
                    <span>Plate</span>
                    <input
                      required
                      value={vehicle.plate_number}
                      disabled={Boolean(selectedVehicleId)}
                      onChange={(event) =>
                        setVehicle({
                          ...vehicle,
                          plate_number: event.target.value.toUpperCase(),
                        })
                      }
                    />
                  </label>
                  <label>
                    <span>Make</span>
                    <input
                      value={vehicle.make}
                      onChange={(event) =>
                        setVehicle({ ...vehicle, make: event.target.value })
                      }
                    />
                  </label>
                  <label>
                    <span>Model</span>
                    <input
                      value={vehicle.model}
                      onChange={(event) =>
                        setVehicle({ ...vehicle, model: event.target.value })
                      }
                    />
                  </label>
                  <label>
                    <span>Year</span>
                    <input
                      type="number"
                      min="1886"
                      max="2200"
                      value={vehicle.year}
                      onChange={(event) =>
                        setVehicle({ ...vehicle, year: event.target.value })
                      }
                    />
                  </label>
                  <label>
                    <span>Colour</span>
                    <input
                      value={vehicle.colour}
                      onChange={(event) =>
                        setVehicle({ ...vehicle, colour: event.target.value })
                      }
                    />
                  </label>
                  <label>
                    <span>Body type</span>
                    <input
                      value={vehicle.body_type}
                      onChange={(event) =>
                        setVehicle({
                          ...vehicle,
                          body_type: event.target.value,
                        })
                      }
                    />
                  </label>
                  <label>
                    <span>Registration expiry</span>
                    <input
                      type="date"
                      value={vehicle.rego_expiry}
                      onChange={(event) =>
                        setVehicle({
                          ...vehicle,
                          rego_expiry: event.target.value,
                        })
                      }
                    />
                  </label>
                  <label>
                    <span>WoF expiry</span>
                    <input
                      type="date"
                      value={vehicle.wof_expiry}
                      onChange={(event) =>
                        setVehicle({
                          ...vehicle,
                          wof_expiry: event.target.value,
                        })
                      }
                    />
                  </label>
                  <label>
                    <span>CoF expiry</span>
                    <input
                      type="date"
                      value={vehicle.cof_expiry}
                      onChange={(event) =>
                        setVehicle({
                          ...vehicle,
                          cof_expiry: event.target.value,
                        })
                      }
                    />
                  </label>
                  <label className="is-wide">
                    <span>Organization note</span>
                    <textarea
                      rows={3}
                      value={vehicle.notes}
                      onChange={(event) =>
                        setVehicle({ ...vehicle, notes: event.target.value })
                      }
                    />
                  </label>
                  <label className="is-wide">
                    <span>Reason for change</span>
                    <textarea
                      required
                      rows={2}
                      value={reason}
                      onChange={(event) => setReason(event.target.value)}
                    />
                  </label>
                </div>
                <button
                  type="submit"
                  className="identity-records-primary"
                  disabled={
                    busy !== null ||
                    !vehicle.plate_number.trim() ||
                    !reason.trim()
                  }
                >
                  <Save size={15} />
                  {busy === "vehicle" ? "Saving" : "Save vehicle"}
                </button>
              </form>
            )}
          </main>
        </div>
        {selectedDocument && (
          <div
            className="identity-document-review"
            role="dialog"
            aria-modal="true"
            aria-labelledby="identity-document-review-title"
          >
            <section>
              <header>
                <div>
                  <span>
                    {selectedDocument.review_state === "manual_review_required"
                      ? "Human review required"
                      : "Evidence review complete"}
                  </span>
                  <h3 id="identity-document-review-title">
                    {selectedDocument.file_name ?? "Identity evidence"}
                  </h3>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedDocument(null);
                    setSourceUrl(null);
                  }}
                  aria-label="Close evidence review"
                >
                  <X size={17} />
                </button>
              </header>
              <div className="identity-document-review-body">
                <div className="identity-document-source">
                  {sourceUrl &&
                  selectedDocument.file_type?.startsWith("image/") ? (
                    <img src={sourceUrl} alt="Uploaded identity evidence" />
                  ) : sourceUrl ? (
                    <a href={sourceUrl} target="_blank" rel="noreferrer">
                      Open source PDF
                    </a>
                  ) : (
                    <p>Preparing the private source preview…</p>
                  )}
                </div>
                <div className="identity-records-fields">
                  <label>
                    <span>Name</span>
                    <input
                      disabled={selectedDocument.review_state !== "manual_review_required"}
                      value={documentFields.display_name}
                      onChange={(event) =>
                        setDocumentFields({
                          ...documentFields,
                          display_name: event.target.value,
                        })
                      }
                    />
                  </label>
                  <label>
                    <span>Date of birth</span>
                    <input
                      type="date"
                      disabled={selectedDocument.review_state !== "manual_review_required"}
                      value={documentFields.date_of_birth}
                      onChange={(event) =>
                        setDocumentFields({
                          ...documentFields,
                          date_of_birth: event.target.value,
                        })
                      }
                    />
                  </label>
                  <label>
                    <span>Driver licence number</span>
                    <input
                      disabled={selectedDocument.review_state !== "manual_review_required"}
                      value={documentFields.driver_licence_number}
                      onChange={(event) =>
                        setDocumentFields({
                          ...documentFields,
                          driver_licence_number: event.target.value,
                        })
                      }
                    />
                  </label>
                  <label>
                    <span>Firearms licence number</span>
                    <input
                      disabled={selectedDocument.review_state !== "manual_review_required"}
                      value={documentFields.firearms_licence_number}
                      onChange={(event) =>
                        setDocumentFields({
                          ...documentFields,
                          firearms_licence_number: event.target.value,
                        })
                      }
                    />
                  </label>
                  <label>
                    <span>Driver licence expiry</span>
                    <input
                      type="date"
                      disabled={selectedDocument.review_state !== "manual_review_required"}
                      value={documentFields.driver_licence_expiry}
                      onChange={(event) =>
                        setDocumentFields({
                          ...documentFields,
                          driver_licence_expiry: event.target.value,
                        })
                      }
                    />
                  </label>
                  <label>
                    <span>Firearms licence expiry</span>
                    <input
                      type="date"
                      disabled={selectedDocument.review_state !== "manual_review_required"}
                      value={documentFields.firearms_licence_expiry}
                      onChange={(event) =>
                        setDocumentFields({
                          ...documentFields,
                          firearms_licence_expiry: event.target.value,
                        })
                      }
                    />
                  </label>
                  {selectedDocument.document_kind === "security_licence" && (
                    <>
                      <label>
                        <span>Security licence / CoA number</span>
                        <input
                          disabled={selectedDocument.review_state !== "manual_review_required"}
                          value={documentFields.security_licence_number}
                          onChange={(event) =>
                            setDocumentFields({
                              ...documentFields,
                              security_licence_number: event.target.value,
                            })
                          }
                        />
                      </label>
                      <label>
                        <span>Security licence / CoA expiry</span>
                        <input
                          type="date"
                          disabled={selectedDocument.review_state !== "manual_review_required"}
                          value={documentFields.security_licence_expiry}
                          onChange={(event) =>
                            setDocumentFields({
                              ...documentFields,
                              security_licence_expiry: event.target.value,
                            })
                          }
                        />
                      </label>
                      <label>
                        <span>Issuing authority</span>
                        <input
                          disabled={selectedDocument.review_state !== "manual_review_required"}
                          value={documentFields.security_licence_authority}
                          onChange={(event) =>
                            setDocumentFields({
                              ...documentFields,
                              security_licence_authority: event.target.value,
                            })
                          }
                        />
                      </label>
                      <label>
                        <span>Endorsements</span>
                        <input
                          disabled={selectedDocument.review_state !== "manual_review_required"}
                          value={documentFields.security_endorsements}
                          onChange={(event) =>
                            setDocumentFields({
                              ...documentFields,
                              security_endorsements: event.target.value,
                            })
                          }
                        />
                      </label>
                    </>
                  )}
                  <label className="is-wide">
                    <span>Address</span>
                    <input
                      disabled={selectedDocument.review_state !== "manual_review_required"}
                      value={documentFields.address}
                      onChange={(event) =>
                        setDocumentFields({
                          ...documentFields,
                          address: event.target.value,
                        })
                      }
                    />
                  </label>
                  <label className="is-wide">
                    <span>Review notes</span>
                    <textarea
                      required
                      disabled={selectedDocument.review_state !== "manual_review_required"}
                      rows={3}
                      value={documentReviewNote}
                      onChange={(event) =>
                        setDocumentReviewNote(event.target.value)
                      }
                      placeholder="What did you compare with the source?"
                    />
                  </label>
                </div>
              </div>
              {(selectedDocument.extracted_fields.candidate_matches?.length ??
                0) > 0 && (
                <div className="identity-candidate-matches">
                  <strong>Possible existing sightings</strong>
                  <p>Similarity only. Compare the source before deciding.</p>
                  {selectedDocument.extracted_fields.candidate_matches?.map(
                    (candidate) => (
                      <div key={`${candidate.match_id}-${candidate.basis}`}>
                        <span>
                          {candidate.display_name || "Unidentified CCTV person"}
                        </span>
                        <small>
                          {Math.round(candidate.score * 100)}% ·{" "}
                          {words(candidate.basis)}
                        </small>
                      </div>
                    ),
                  )}
                </div>
              )}
              <footer>
                {selectedDocument.review_state === "manual_review_required" ? (
                  <>
                    <button
                      type="button"
                      onClick={() => void reviewDocument("reject")}
                      disabled={busy !== null || !documentReviewNote.trim()}
                    >
                      Reject evidence
                    </button>
                    <button
                      type="button"
                      className="identity-records-primary"
                      onClick={() => void reviewDocument("approve")}
                      disabled={busy !== null || !documentReviewNote.trim()}
                    >
                      <CheckCircle2 size={15} />
                      Approve and update person
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedDocument(null);
                      setSourceUrl(null);
                    }}
                  >
                    Close
                  </button>
                )}
              </footer>
            </section>
          </div>
        )}
      </section>
    </div>
  );
}
