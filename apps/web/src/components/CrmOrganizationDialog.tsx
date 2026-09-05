import { useRef, useState, type FormEvent } from "react";
import {
  AlertTriangle,
  Building2,
  CheckCircle2,
  Search,
  X,
} from "lucide-react";
import { supabase } from "../lib/supabase";
import "./CrmOrganizationDialog.css";

export interface EditableCrmOrganization {
  id: string;
  name: string;
  organization_type: string;
  status: string;
  updated_at: string;
  nzbn: string | null;
  company_registration_number: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  billing_email: string | null;
  billing_address: string | null;
  account_notes: string | null;
}

interface Candidate {
  id: string;
  name: string;
  organization_type: string;
  status: string;
  nzbn: string | null;
  match_reason: string;
  manageable: boolean;
}

const emptyForm = {
  name: "",
  type: "client",
  nzbn: "",
  companyNumber: "",
  contactEmail: "",
  contactPhone: "",
  billingEmail: "",
  billingAddress: "",
  notes: "",
};

export function CrmOrganizationDialog({
  organization,
  onClose,
  onUpdated,
  onOpenAccount,
}: {
  organization?: EditableCrmOrganization | null;
  onClose: () => void;
  onUpdated: (name: string) => void;
  onOpenAccount: (organization: { id: string; name: string }) => void;
}) {
  const editing = Boolean(organization);
  const [stage, setStage] = useState<"search" | "form">(
    editing ? "form" : "search",
  );
  const [query, setQuery] = useState("");
  const [searchNzbn, setSearchNzbn] = useState("");
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [searched, setSearched] = useState(false);
  const [form, setForm] = useState(
    organization
      ? {
          name: organization.name,
          type: organization.organization_type,
          nzbn: organization.nzbn ?? "",
          companyNumber: organization.company_registration_number ?? "",
          contactEmail: organization.contact_email ?? "",
          contactPhone: organization.contact_phone ?? "",
          billingEmail: organization.billing_email ?? "",
          billingAddress: organization.billing_address ?? "",
          notes: organization.account_notes ?? "",
        }
      : emptyForm,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ id: string; name: string } | null>(null);
  const requestId = useRef(crypto.randomUUID());

  const searchCandidates = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setSearched(false);
    const { data, error: searchError } = await supabase.rpc(
      "find_crm_organization_candidates",
      { p_query: query.trim(), p_nzbn: searchNzbn.trim() || null },
    );
    if (searchError) setError(searchError.message);
    else {
      setCandidates((data as Candidate[]) ?? []);
      setSearched(true);
    }
    setSaving(false);
  };

  const continueToCreate = () => {
    setForm({ ...emptyForm, name: query.trim(), nzbn: searchNzbn.trim() });
    setStage("form");
    setError(null);
  };

  const saveOrganization = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    const { data, error: saveError } = await supabase.rpc(
      "manage_crm_organization",
      {
        p_client_request_id: requestId.current,
        p_organization_id: organization?.id ?? null,
        p_expected_updated_at: organization?.updated_at ?? null,
        p_action: editing ? "update" : "create",
        p_name: form.name.trim(),
        p_organization_type: form.type,
        p_nzbn: form.nzbn.trim() || null,
        p_company_registration_number: form.companyNumber.trim() || null,
        p_contact_email: form.contactEmail.trim() || null,
        p_contact_phone: form.contactPhone.trim() || null,
        p_billing_email: form.billingEmail.trim() || null,
        p_billing_address: form.billingAddress.trim() || null,
        p_account_notes: form.notes.trim() || null,
        p_status: null,
      },
    );
    if (saveError || !data)
      setError(
        saveError?.message ??
          "Organization receipt was not confirmed. Your entries remain available.",
      );
    else {
      const row = data as { id: string; name: string };
      requestId.current = crypto.randomUUID();
      if (editing) onUpdated(row.name);
      else setSaved(row);
    }
    setSaving(false);
  };

  return (
    <div className="crm-org-backdrop">
      <section
        className="crm-org-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="crm-org-title"
      >
        <header>
          <div>
            <span>Organization spine</span>
            <h2 id="crm-org-title">
              {editing
                ? `Edit ${organization?.name}`
                : saved
                  ? "Prospect created"
                  : stage === "search"
                    ? "Find or add an organization"
                    : "Create prospect"}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close organization dialog"
          >
            <X size={18} />
          </button>
        </header>
        {error && (
          <div className="crm-org-message" role="alert">
            <AlertTriangle size={16} />
            {error}
          </div>
        )}
        {saved ? (
          <div className="crm-org-success">
            <CheckCircle2 size={28} />
            <h3>{saved.name} is now a prospect</h3>
            <p>
              The account is intentionally inactive. Add the primary contact
              next; sites, agreement, modules, billing, and operations will
              remain visible as readiness steps.
            </p>
            <div>
              <button type="button" onClick={onClose}>
                Back to CRM
              </button>
              <button type="button" onClick={() => onOpenAccount(saved)}>
                Add primary contact
              </button>
            </div>
          </div>
        ) : stage === "search" ? (
          <form className="crm-org-search" onSubmit={searchCandidates}>
            <p>
              Search before creating. Find organizations by name, address,
              client ID, or contact person; close spellings are included to
              prevent duplicate accounts and preserve relationship history.
            </p>
            <label>
              <span>Organization, company number, address, client ID, or contact</span>
              <div>
                <Search size={16} />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="e.g. security, 100 Test Avenue, NCC200, Ari AAM"
                />
              </div>
            </label>
            <label>
              <span>NZBN, if known</span>
              <input
                inputMode="numeric"
                value={searchNzbn}
                onChange={(event) => setSearchNzbn(event.target.value)}
                placeholder="13 digits"
              />
            </label>
            <a
              className="crm-org-external-link"
              href="https://app.companiesoffice.govt.nz/companies/app/ui/pages/companies/search?advancedPanel=true"
              target="_blank"
              rel="noreferrer"
            >
              Search Companies Register
            </a>
            <button
              type="submit"
              disabled={
                saving || (query.trim().length < 2 && !searchNzbn.trim())
              }
            >
              {saving ? "Searching" : "Search organizations"}
            </button>
            {searched && (
              <section className="crm-org-results">
                <header>
                  <strong>
                    {candidates.length
                      ? "Possible matches"
                      : "No matching organizations found"}
                  </strong>
                  <span>
                    {candidates.length
                      ? "Review these records before creating another."
                      : "You can continue with a new prospect."}
                  </span>
                </header>
                {candidates.map((candidate) => (
                  <article key={candidate.id}>
                    <Building2 size={19} />
                    <div>
                      <strong>{candidate.name}</strong>
                      <span>
                        {candidate.organization_type.replaceAll("_", " ")} ·{" "}
                        {candidate.status} · {candidate.match_reason}
                        {candidate.nzbn ? ` · NZBN ${candidate.nzbn}` : ""}
                      </span>
                    </div>
                    <span className={candidate.manageable ? "is-managed" : ""}>
                      {candidate.manageable
                        ? "Managed account"
                        : "Existing record"}
                    </span>
                    {candidate.manageable && (
                      <button
                        type="button"
                        onClick={() => onOpenAccount(candidate)}
                      >
                        Open account
                      </button>
                    )}
                  </article>
                ))}
                <button type="button" onClick={continueToCreate}>
                  {candidates.length
                    ? "None of these - create prospect"
                    : "Create new prospect"}
                </button>
              </section>
            )}
          </form>
        ) : (
          <form className="crm-org-form" onSubmit={saveOrganization}>
            <p>
              {editing
                ? "Update the canonical organization record. Changes are race-checked against the version you opened."
                : "Start with the minimum account identity. Operational and commercial setup happen as visible next steps."}
            </p>
            <div className="crm-org-grid">
              <label>
                <span>Organization name</span>
                <input
                  required
                  minLength={2}
                  maxLength={200}
                  value={form.name}
                  onChange={(event) =>
                    setForm({ ...form, name: event.target.value })
                  }
                />
              </label>
              <label>
                <span>Account type</span>
                <select
                  value={form.type}
                  onChange={(event) =>
                    setForm({ ...form, type: event.target.value })
                  }
                >
                  <option value="client">Client</option>
                  <option value="government">Government</option>
                  <option value="private_enterprise">Private enterprise</option>
                  <option value="contractor">Contractor</option>
                  <option value="branch">Branch</option>
                </select>
              </label>
            </div>
            <div className="crm-org-grid">
              <label>
                <span>NZBN</span>
                <input
                  inputMode="numeric"
                  value={form.nzbn}
                  onChange={(event) =>
                    setForm({ ...form, nzbn: event.target.value })
                  }
                />
              </label>
              <label>
                <span>Company number</span>
                <input
                  value={form.companyNumber}
                  onChange={(event) =>
                    setForm({ ...form, companyNumber: event.target.value })
                  }
                />
                <a
                  className="crm-org-external-link"
                  href="https://app.companiesoffice.govt.nz/companies/app/ui/pages/companies/search?advancedPanel=true"
                  target="_blank"
                  rel="noreferrer"
                >
                  Search Companies Register
                </a>
              </label>
            </div>
            <div className="crm-org-grid">
              <label>
                <span>General email</span>
                <input
                  type="email"
                  value={form.contactEmail}
                  onChange={(event) =>
                    setForm({ ...form, contactEmail: event.target.value })
                  }
                />
              </label>
              <label>
                <span>General phone</span>
                <input
                  value={form.contactPhone}
                  onChange={(event) =>
                    setForm({ ...form, contactPhone: event.target.value })
                  }
                />
              </label>
            </div>
            <div className="crm-org-grid">
              <label>
                <span>Billing email</span>
                <input
                  type="email"
                  value={form.billingEmail}
                  onChange={(event) =>
                    setForm({ ...form, billingEmail: event.target.value })
                  }
                />
              </label>
              <label>
                <span>Billing address</span>
                <input
                  value={form.billingAddress}
                  onChange={(event) =>
                    setForm({ ...form, billingAddress: event.target.value })
                  }
                />
              </label>
            </div>
            <label>
              <span>Account context</span>
              <textarea
                rows={3}
                value={form.notes}
                onChange={(event) =>
                  setForm({ ...form, notes: event.target.value })
                }
                placeholder="Why this account exists, what they need, and who owns the next conversation"
              />
            </label>
            <footer>
              {!editing && (
                <button type="button" onClick={() => setStage("search")}>
                  Back to search
                </button>
              )}
              <button
                type="submit"
                disabled={saving || form.name.trim().length < 2}
              >
                {saving
                  ? "Saving"
                  : editing
                    ? "Save organization"
                    : "Create inactive prospect"}
              </button>
            </footer>
          </form>
        )}
      </section>
    </div>
  );
}
