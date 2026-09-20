import { useCallback, useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  Clock3,
  History,
  MailPlus,
  Plus,
  RefreshCw,
  Rocket,
  UserRound,
  X,
} from "lucide-react";
import { supabase } from "../lib/supabase";
import { readWorkflowContext, type NavigateWithContext, type WorkflowContext } from "../lib/workflowNavigation";
import { CrmOrganizationDialog } from "../components/CrmOrganizationDialog";
import { ShellLayout } from "../layouts/ShellLayout";
import "./AccountOnboardingPage.css";
import "./AccountOnboardingUnavailable.css";
import "./AccountOnboardingOwnership.css";

interface Dimension {
  key: string;
  label: string;
  status: "ready" | "blocked";
  detail: string;
  owner: string;
  destination: string;
}
interface QueueRow {
  ledger_id: string;
  account_organization_id: string;
  account_name: string;
  organization_status: string;
  organization_updated_at: string;
  current_stage: "qualify" | "configure" | "review";
  ledger_status: string;
  version: number;
  started_at: string;
  target_live_at: string;
  days_open: number;
  overdue: boolean;
  has_primary_contact: boolean;
  agreement_id: string | null;
  agreement_name: string | null;
  readiness: { ready: boolean; dimensions: Dimension[] } | null;
  assigned_to: string | null;
  assigned_name: string | null;
  stage_note: string | null;
}
interface Assignee { user_id: string; display_name: string; role: string }
interface OnboardingEvent { event_id: string; event_type: string; from_stage: string | null; to_stage: string; ledger_status: string; assigned_name: string | null; note: string; actor_name: string | null; ledger_version: number; created_at: string }
const stages = ["qualify", "configure", "review"] as const;

export default function AccountOnboardingPage({
  onNavigate,
}: {
  onNavigate: NavigateWithContext;
}) {
  const location = useLocation();
  const requestedContext = readWorkflowContext(location.search);
  const [rows, setRows] = useState<QueueRow[]>([]),
    [selectedId, setSelectedId] = useState<string | null>(null),
    [loading, setLoading] = useState(true),
    [saving, setSaving] = useState(false),
    [loadError, setLoadError] = useState<string | null>(null),
    [error, setError] = useState<string | null>(null),
    [notice, setNotice] = useState<string | null>(null),
    [handoffReady, setHandoffReady] = useState(false),
    [activatedContext, setActivatedContext] = useState<WorkflowContext | null>(null),
    [confirming, setConfirming] = useState(false),
    [targetDate, setTargetDate] = useState(""),
    [assignees, setAssignees] = useState<Assignee[]>([]),
    [assignedTo, setAssignedTo] = useState(""),
    [stageNote, setStageNote] = useState(""),
    [history, setHistory] = useState<OnboardingEvent[]>([]),
    [showCreateAccount, setShowCreateAccount] = useState(false),
    [confirmingInvite, setConfirmingInvite] = useState(false),
    [inviting, setInviting] = useState(false);
  const selected = rows.find((row) => row.ledger_id === selectedId) ?? null;
  const loadQueue = useCallback(async (preferred?: string) => {
    setLoading(true);
    setLoadError(null);
    const [queueResult, assigneeResult] = await Promise.all([
      supabase.rpc("get_crm_onboarding_workspace"),
      supabase.rpc("get_crm_onboarding_assignees"),
    ]);
    if (queueResult.error || assigneeResult.error) {
      setRows([]);
      setSelectedId(null);
      setLoadError(queueResult.error?.message ?? assigneeResult.error?.message ?? "Onboarding workspace unavailable");
    } else {
      const next = (queueResult.data as QueueRow[]) ?? [];
      setRows(next);
      setAssignees((assigneeResult.data as Assignee[]) ?? []);
      const requested = next.find((row) => row.ledger_id === requestedContext.ledgerId || row.account_organization_id === requestedContext.accountId);
      setSelectedId(preferred && next.some((row) => row.ledger_id === preferred) ? preferred : requested?.ledger_id ?? next[0]?.ledger_id ?? null);
    }
    setLoading(false);
  }, [requestedContext.accountId, requestedContext.ledgerId]);
  useEffect(() => {
    void loadQueue();
  }, [loadQueue]);
  useEffect(() => {
    if (!selected) { setHistory([]); return; }
    setTargetDate(selected.target_live_at.slice(0, 10));
    setAssignedTo(selected.assigned_to ?? "");
    setStageNote(selected.stage_note ?? "");
    const loadHistory = async () => {
      const { data, error: historyError } = await supabase.rpc("get_crm_onboarding_history", { p_account_organization_id: selected.account_organization_id });
      if (historyError) setError(historyError.message); else setHistory((data as OnboardingEvent[]) ?? []);
    };
    void loadHistory();
  }, [selectedId, selected?.version]);
  const saveWorkflow = async (advanceStage: boolean) => {
    if (!selected) return;
    const index = stages.indexOf(selected.current_stage);
    const nextStage = advanceStage && index < stages.length - 1 ? stages[index + 1] : selected.current_stage;
    setSaving(true);
    setError(null);
    const { error: actionError } = await supabase.rpc(
      "manage_crm_onboarding_workflow",
      {
        p_account_organization_id: selected.account_organization_id,
        p_expected_version: selected.version,
        p_stage: nextStage,
        p_target_live_at: `${targetDate}T23:59:59Z`,
        p_assigned_to: assignedTo || null,
        p_note: stageNote,
      },
    );
    if (actionError) setError(actionError.message);
    else {
      setNotice(advanceStage ? `${selected.account_name} advanced to ${nextStage}.` : `${selected.account_name} workflow ownership updated.`);
      await loadQueue(selected.ledger_id);
    }
    setSaving(false);
  };
  const activate = async () => {
    if (!selected?.agreement_id) return;
    setSaving(true);
    setError(null);
    const { error: actionError } = await supabase.rpc("activate_crm_account", {
      p_account_organization_id: selected.account_organization_id,
      p_agreement_id: selected.agreement_id,
      p_expected_organization_updated_at: selected.organization_updated_at,
      p_expected_ledger_version: selected.version,
    });
    if (actionError) setError(actionError.message);
    else {
      setNotice(
        `${selected.account_name} activated and removed from the incomplete queue.`,
      );
      setActivatedContext({ accountId: selected.account_organization_id, agreementId: selected.agreement_id ?? undefined, ledgerId: selected.ledger_id });
      setHandoffReady(true);
      setConfirming(false);
      await loadQueue();
    }
    setSaving(false);
  };
  const inviteClient = async () => {
    if (!selected) return;
    setInviting(true);
    setError(null);
    const { data: prepared, error: prepareError } = await supabase.rpc("prepare_crm_client_invitation", { p_account_organization_id: selected.account_organization_id });
    if (prepareError || !prepared) {
      setError(prepareError?.message ?? "The client invitation could not be prepared.");
      setInviting(false);
      return;
    }
    const invitation = prepared as { email: string; display_name?: string };
    const { error: inviteError } = await supabase.functions.invoke("invite-org", {
      body: { target_organization_id: selected.account_organization_id, email: invitation.email, display_name: invitation.display_name?.trim() || selected.account_name },
    });
    if (inviteError) setError(inviteError.message);
    else {
      setNotice(`Client invitation sent to ${invitation.email}. They become the client's administrator in the client portal; the account stays provider-managed until they set their password and accept.`);
      setConfirmingInvite(false);
      await loadQueue(selected.ledger_id);
    }
    setInviting(false);
  };
  const blockers = [
    ...(selected?.has_primary_contact
      ? []
      : [
          {
            key: "contact",
            label: "Primary contact",
            status: "blocked" as const,
            detail: "An active primary contact is required",
            owner: "Account administration",
            destination: "crm",
          },
        ]),
    ...(selected?.readiness?.dimensions ?? []),
  ].filter((item) => item.status === "blocked");
  if (loadError)
    return (
      <ShellLayout shell="admin" className="onboarding-shell">
        <div className="onboarding-page">
        <header>
          <div>
            <span>Client setup</span>
            <h1>Set up a new client</h1>
            <p>
              Work through the few things needed before service can start:
              client details, agreement, places, and a final readiness check.
            </p>
          </div>
        </header>
        <section className="onboarding-unavailable" role="alert">
          <AlertTriangle size={24} />
          <div>
            <h2>Onboarding data unavailable</h2>
            <p>
              The governed onboarding service could not be loaded. Queue totals
              and account status are hidden until the service responds.
            </p>
            <code>{loadError}</code>
          </div>
          <button
            type="button"
            onClick={() => void loadQueue()}
            disabled={loading}
          >
            <RefreshCw size={15} className={loading ? "is-spinning" : ""} />
            {loading ? "Retrying" : "Retry"}
          </button>
        </section>
        </div>
      </ShellLayout>
    );
  return (
    <ShellLayout shell="admin" className="onboarding-shell">
      <div className="onboarding-page">
      <header>
        <div>
          <span>Client setup</span>
          <h1>Set up a new client</h1>
          <p>
            Work through the few things needed before service can start:
            client details, agreement, places, and a final readiness check.
          </p>
        </div>
        <div className="onboarding-header-actions">
          <button className="is-new-account" onClick={() => setShowCreateAccount(true)}>
            <Plus size={16} />
            New account
          </button>
          <button onClick={() => void loadQueue()} disabled={loading}>
            <RefreshCw size={16} className={loading ? "is-spinning" : ""} />
            Refresh
          </button>
        </div>
      </header>
      {showCreateAccount && (
        <CrmOrganizationDialog
          organization={null}
          onClose={() => setShowCreateAccount(false)}
          onUpdated={() => setShowCreateAccount(false)}
          onOpenAccount={(account) => {
            setShowCreateAccount(false);
            void loadQueue();
            onNavigate("crm", { accountId: account.id });
          }}
          onUseOrganization={() => {
            setShowCreateAccount(false);
            onNavigate("crm", {});
          }}
        />
      )}
      {error && (
        <div className="onboarding-message is-error" role="alert">
          <AlertTriangle size={16} />
          {error}
        </div>
      )}
      {notice && (
        <div className="onboarding-message is-success" role="status">
          <CheckCircle2 size={16} />
          <span>{notice}</span>
          {handoffReady && <button type="button" onClick={() => onNavigate('handoffs', activatedContext ?? {})} aria-label="Open activation handoff details">Open activation handoff</button>}
        </div>
      )}
      <section className="onboarding-summary">
        <div>
          <Clock3 size={18} />
          <span>In progress</span>
          <strong>{rows.length}</strong>
        </div>
        <div>
          <AlertTriangle size={18} />
          <span>Overdue</span>
          <strong>{rows.filter((row) => row.overdue).length}</strong>
        </div>
        <div>
          <CalendarClock size={18} />
          <span>In review</span>
          <strong>
            {rows.filter((row) => row.current_stage === "review").length}
          </strong>
        </div>
      </section>
      <div className="onboarding-workspace">
        <aside>
          <div className="onboarding-queue-title">
            <strong>Incomplete accounts</strong>
            <span>Target-live order</span>
          </div>
          {rows.length ? (
            rows.map((row) => (
              <button
                key={row.ledger_id}
                className={row.ledger_id === selectedId ? "is-selected" : ""}
                onClick={() => setSelectedId(row.ledger_id)}
              >
                <span className={row.overdue ? "is-overdue" : ""}>
                  {row.days_open}d
                </span>
                <div>
                  <strong>{row.account_name}</strong>
                  <small>
                    {row.current_stage} · {row.ledger_status}
                  </small>
                  <small>
                    Target{" "}
                    {new Date(row.target_live_at).toLocaleDateString("en-NZ")}
                  </small>
                </div>
                <ChevronRight size={15} />
              </button>
            ))
          ) : (
            <div className="onboarding-empty">
              No incomplete onboarding accounts.
              <button type="button" className="is-new-account" onClick={() => setShowCreateAccount(true)} aria-label="Create new subscriber account">
                <Plus size={14} />
                Set up a new subscriber
              </button>
            </div>
          )}
        </aside>
        <main>
          {selected ? (
            <>
              <header>
                <div>
                  <span>{selected.organization_status} account</span>
                  <h2>{selected.account_name}</h2>
                  <p>
                    {selected.agreement_name ?? "No operational agreement yet"}
                  </p>
                </div>
                <strong className={selected.overdue ? "is-overdue" : ""}>
                  {selected.overdue
                    ? "Target overdue"
                    : `${selected.days_open} days open`}
                </strong>
              </header>
              <div className="onboarding-stages">
                {stages.map((stage, index) => (
                  <div
                    className={
                      index <= stages.indexOf(selected.current_stage)
                        ? "is-complete"
                        : ""
                    }
                    key={stage}
                  >
                    <span>{index + 1}</span>
                    <strong>{stage}</strong>
                  </div>
                ))}
              </div>
              <section className="onboarding-controls">
                <label>
                  <span>Workflow owner</span>
                  <select aria-label="Workflow owner" value={assignedTo} onChange={(event) => setAssignedTo(event.target.value)}>
                    <option value="">Select administrator</option>
                    {assignees.map((assignee) => <option key={assignee.user_id} value={assignee.user_id}>{assignee.display_name} · {assignee.role}</option>)}
                  </select>
                </label>
                <label>
                  <span>Target live date</span>
                  <input
                    type="date"
                    aria-label="Target live date"
                    value={targetDate}
                    onChange={(event) => setTargetDate(event.target.value)}
                  />
                </label>
                <label className="onboarding-note-field">
                  <span>Stage note</span>
                  <textarea aria-label="Stage note" rows={3} maxLength={1000} value={stageNote} onChange={(event) => setStageNote(event.target.value)} placeholder="Record the decision, handoff, or next action" />
                </label>
                <div>
                  <button onClick={() => void saveWorkflow(false)} disabled={saving || !assignedTo || stageNote.trim().length < 3}>
                    {saving ? "Saving" : "Save ownership"}
                  </button>
                  {selected.current_stage !== "review" && (
                    <button onClick={() => void saveWorkflow(true)} disabled={saving || !assignedTo || stageNote.trim().length < 3}>
                      {saving ? "Saving" : "Advance stage"}
                    </button>
                  )}
                  {selected.current_stage === "review" && (
                    <button
                      className="is-activate"
                      onClick={() => setConfirming(true)}
                      disabled={saving || blockers.length > 0 || !selected.assigned_to || !selected.stage_note}
                    >
                      <Rocket size={15} />
                      Activate account
                    </button>
                  )}
                  <button className="is-invite" onClick={() => setConfirmingInvite(true)} disabled={saving || inviting}>
                    <MailPlus size={15} />
                    Invite client
                  </button>
                </div>
              </section>
              <section className="onboarding-history">
                <header><div><History size={17} /><span><h3>Workflow history</h3><p>{history.length} immutable {history.length === 1 ? "event" : "events"}</p></span></div></header>
                {history.length ? <div>{history.map((event) => <article key={event.event_id}><span><UserRound size={15} /></span><div><strong>{event.event_type.replaceAll("_", " ")} · {event.to_stage}</strong><p>{event.note}</p><small>{event.assigned_name ?? "Unassigned"} · by {event.actor_name ?? "System"}</small></div><time dateTime={event.created_at}>v{event.ledger_version} · {new Date(event.created_at).toLocaleString("en-NZ")}</time></article>)}</div> : <div className="onboarding-empty">No workflow events recorded.</div>}
              </section>
              <section className="onboarding-evidence">
                <header>
                  <div>
                    <h3>Activation evidence</h3>
                    <p>
                      {blockers.length
                        ? `${blockers.length} blockers remain`
                        : "All mandatory evidence is ready"}
                    </p>
                  </div>
                </header>
                <div>
                  {!selected.has_primary_contact && (
                    <Evidence
                      label="Primary contact"
                      detail="An active primary contact is required"
                      owner="Account administration"
                      onOpen={() => onNavigate("crm", { accountId: selected.account_organization_id, agreementId: selected.agreement_id ?? undefined, ledgerId: selected.ledger_id })}
                    />
                  )}{" "}
                  {(selected.readiness?.dimensions ?? []).map((item) => (
                    <article key={item.key} className={`is-${item.status}`}>
                      <span>
                        {item.status === "ready" ? (
                          <CheckCircle2 size={16} />
                        ) : (
                          <AlertTriangle size={16} />
                        )}
                      </span>
                      <div>
                        <strong>{item.label}</strong>
                        <p>{item.detail}</p>
                        <small>{item.owner}</small>
                      </div>
                      {item.status === "blocked" && (
                        <button onClick={() => onNavigate(item.destination, { accountId: selected.account_organization_id, agreementId: selected.agreement_id ?? undefined, ledgerId: selected.ledger_id })}>
                          Open owner
                        </button>
                      )}
                    </article>
                  ))}
                </div>
              </section>
            </>
          ) : (
            <div className="onboarding-empty">
              Select an account to resume onboarding.
            </div>
          )}
        </main>
      </div>
      {confirming && selected && (
        <div className="activation-backdrop">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="activation-title"
          >
            <header>
              <div>
                <span>Final activation gate</span>
                <h2 id="activation-title">Activate {selected.account_name}?</h2>
              </div>
              <button
                onClick={() => setConfirming(false)}
                aria-label="Close activation confirmation"
              >
                <X size={17} />
              </button>
            </header>
            <p>
              This makes the organization active. The server will lock and
              recheck the prospect, ledger version, accepted agreement, primary
              contact, and all operational readiness dimensions.
            </p>
            <footer>
              <button onClick={() => setConfirming(false)}>Back</button>
              <button
                className="is-primary"
                onClick={() => void activate()}
                disabled={saving}
              >
                {saving ? "Activating" : "Confirm activation"}
              </button>
            </footer>
          </section>
        </div>
      )}
      {confirmingInvite && selected && (
        <div className="activation-backdrop">
          <section role="dialog" aria-modal="true" aria-labelledby="invite-client-title">
            <header><div><span>Provider handoff</span><h2 id="invite-client-title">Invite {selected.account_name}?</h2></div><button onClick={() => setConfirmingInvite(false)} aria-label="Close client invitation confirmation"><X size={17} /></button></header>
            <p>The server will verify the primary client contact, service agreement, active site, and active zone, and that nobody at the client can sign in yet. The primary contact receives an email, becomes the client's administrator in the client portal, and accepts by setting their password. Client access begins when they do.</p>
            <footer><button onClick={() => setConfirmingInvite(false)}>Back</button><button className="is-primary" onClick={() => void inviteClient()} disabled={inviting}>{inviting ? "Preparing invitation" : "Confirm and invite"}</button></footer>
          </section>
        </div>
      )}
      </div>
    </ShellLayout>
  );
}
function Evidence({
  label,
  detail,
  owner,
  onOpen,
}: {
  label: string;
  detail: string;
  owner: string;
  onOpen: () => void;
}) {
  return (
    <article className="is-blocked">
      <span>
        <AlertTriangle size={16} />
      </span>
      <div>
        <strong>{label}</strong>
        <p>{detail}</p>
        <small>{owner}</small>
      </div>
      <button onClick={onOpen}>Open owner</button>
    </article>
  );
}
