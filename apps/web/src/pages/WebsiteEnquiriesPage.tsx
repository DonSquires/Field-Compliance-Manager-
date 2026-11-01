import { useCallback, useEffect, useMemo, useState } from 'react';
import { Inbox, RefreshCw, ShieldAlert } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { isAdminTierRole } from '../lib/roles';
import { supabase } from '../lib/supabase';
import type { NavigateWithContext } from '../lib/workflowNavigation';
import './PageStyles.css';
import './WebsiteEnquiriesPage.css';

type EnquiryStatus = 'new' | 'contacted' | 'converted' | 'closed' | 'spam';
type StatusFilter = EnquiryStatus | 'all';
type ReviewStatus = Exclude<EnquiryStatus, 'new'>;

interface WebsiteEnquiry {
  id: string;
  reference: string;
  received_at: string;
  name: string;
  email: string | null;
  phone: string | null;
  organisation: string | null;
  location: string | null;
  services: string[] | null;
  message: string;
  preferred_contact: 'email' | 'phone' | 'either';
  source_page: string | null;
  status: EnquiryStatus;
  status_note: string | null;
  handled_at: string | null;
  version: number;
}

interface ReviewAction {
  status: ReviewStatus;
  label: string;
  noteRequired: boolean;
}

interface PendingAction {
  enquiryId: string;
  action: ReviewAction;
}

const ENQUIRY_COLUMNS = 'id, reference, received_at, name, email, phone, organisation, location, services, message, preferred_contact, source_page, status, status_note, handled_at, version';
const PAGE_LIMIT = 200;
const MESSAGE_PREVIEW_LENGTH = 180;

const STATUS_FILTERS: Array<{ value: StatusFilter; label: string }> = [
  { value: 'new', label: 'New' },
  { value: 'contacted', label: 'Contacted' },
  { value: 'converted', label: 'Converted' },
  { value: 'closed', label: 'Closed' },
  { value: 'spam', label: 'Spam' },
  { value: 'all', label: 'All' },
];

const STATUS_LABELS: Record<EnquiryStatus, string> = {
  new: 'New',
  contacted: 'Contacted',
  converted: 'Converted',
  closed: 'Closed',
  spam: 'Spam',
};

const STATUS_BADGES: Record<EnquiryStatus, string> = {
  new: 'badge badge-warning',
  contacted: 'badge badge-info',
  converted: 'badge badge-success',
  closed: 'badge',
  spam: 'badge badge-danger',
};

const SERVICE_LABELS: Record<string, string> = {
  'static-guarding': 'Static guarding',
  'patrols-response': 'Patrols and response',
  'cctv-surveillance': 'CCTV surveillance',
  raptor: 'Raptor',
  'gates-access': 'Gates and access',
  investigations: 'Investigations',
  'forestry-rural': 'Forestry and rural',
  'rams-permits': 'RAMS and permits',
  'council-compliance': 'Council compliance',
  'pest-control': 'Pest control',
  other: 'Other',
};

const PREFERRED_CONTACT_LABELS: Record<WebsiteEnquiry['preferred_contact'], string> = {
  email: 'Prefers email',
  phone: 'Prefers a phone call',
  either: 'Email or phone is fine',
};

const MARK_CONTACTED: ReviewAction = { status: 'contacted', label: 'Mark contacted', noteRequired: false };
const CONVERTED: ReviewAction = { status: 'converted', label: 'Converted', noteRequired: true };
const CLOSE: ReviewAction = { status: 'closed', label: 'Close', noteRequired: true };
const SPAM: ReviewAction = { status: 'spam', label: 'Spam', noteRequired: true };
const REOPEN: ReviewAction = { status: 'contacted', label: 'Reopen as contacted', noteRequired: true };

// Mirrors review_website_enquiry: converted is final; closed and spam can only reopen as contacted.
function actionsFor(status: EnquiryStatus): ReviewAction[] {
  if (status === 'new') return [MARK_CONTACTED, CONVERTED, CLOSE, SPAM];
  if (status === 'contacted') return [CONVERTED, CLOSE, SPAM];
  if (status === 'closed' || status === 'spam') return [REOPEN];
  return [];
}

const receivedFormatter = new Intl.DateTimeFormat('en-NZ', {
  timeZone: 'Pacific/Auckland',
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

function formatReceived(value: string | null): string {
  if (!value) return 'Unknown time';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unknown time' : receivedFormatter.format(date);
}

function isStaleVersionError(error: { code?: string; message?: string }): boolean {
  return error.code === 'PT409' || /changed by someone else/i.test(error.message ?? '');
}

function matchesSearch(enquiry: WebsiteEnquiry, search: string): boolean {
  if (!search) return true;
  return [enquiry.name, enquiry.organisation, enquiry.reference, enquiry.email]
    .some((value) => value?.toLowerCase().includes(search));
}

export default function WebsiteEnquiriesPage({ onNavigate }: { onNavigate: NavigateWithContext }) {
  const { profile } = useAuth();
  const canReview = isAdminTierRole(profile?.role);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('new');
  const [search, setSearch] = useState('');
  const [enquiries, setEnquiries] = useState<WebsiteEnquiry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<{ message: string; stale: boolean } | null>(null);
  const [notice, setNotice] = useState<{ message: string; converted: boolean } | null>(null);

  const loadEnquiries = useCallback(async () => {
    if (!canReview) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError(null);
    setPermissionDenied(false);
    let query = supabase
      .from('website_enquiries')
      .select(ENQUIRY_COLUMNS)
      .order('received_at', { ascending: false })
      .limit(PAGE_LIMIT);
    if (statusFilter !== 'all') query = query.eq('status', statusFilter);
    const { data, error } = await query;
    if (error) {
      if (error.code === '42501') setPermissionDenied(true);
      else setLoadError(error.message || 'Website enquiries could not be loaded.');
      setEnquiries([]);
    } else {
      setEnquiries((data ?? []) as WebsiteEnquiry[]);
    }
    setLoading(false);
  }, [canReview, statusFilter]);

  useEffect(() => {
    void loadEnquiries();
  }, [loadEnquiries]);

  const searchTerm = search.trim().toLowerCase();
  const visibleEnquiries = useMemo(
    () => enquiries.filter((enquiry) => matchesSearch(enquiry, searchTerm)),
    [enquiries, searchTerm],
  );

  const startAction = (enquiry: WebsiteEnquiry, action: ReviewAction) => {
    setPending({ enquiryId: enquiry.id, action });
    setNote('');
    setActionError(null);
    setNotice(null);
  };

  const cancelAction = () => {
    setPending(null);
    setNote('');
    setActionError(null);
  };

  const submitAction = async (enquiry: WebsiteEnquiry) => {
    if (!pending || pending.enquiryId !== enquiry.id) return;
    const trimmedNote = note.trim();
    if (pending.action.noteRequired && trimmedNote.length < 3) {
      setActionError({ message: 'Add a short note saying why (at least 3 characters).', stale: false });
      return;
    }
    setSaving(true);
    setActionError(null);
    const { error } = await supabase.rpc('review_website_enquiry', {
      p_enquiry_id: enquiry.id,
      p_status: pending.action.status,
      p_note: trimmedNote || null,
      p_expected_version: enquiry.version,
    });
    setSaving(false);
    if (error) {
      setActionError(isStaleVersionError(error)
        ? { message: 'This enquiry was changed by someone else. Reload the list and try again.', stale: true }
        : { message: error.message || 'The enquiry could not be updated.', stale: false });
      return;
    }
    const converted = pending.action.status === 'converted';
    setPending(null);
    setNote('');
    setNotice({
      message: `${enquiry.reference} is now ${STATUS_LABELS[pending.action.status].toLowerCase()}.`,
      converted,
    });
    await loadEnquiries();
  };

  const reloadAfterConflict = async () => {
    setPending(null);
    setNote('');
    setActionError(null);
    await loadEnquiries();
  };

  const header = (
    <header className="page-header">
      <div>
        <span className="eyebrow">CRM and clients</span>
        <h1>Website enquiries</h1>
        <p className="subtitle">Messages sent through the R&amp;M Security website. Reply, then record what happened.</p>
      </div>
      {canReview && !permissionDenied && (
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => void loadEnquiries()} disabled={loading}>
          <RefreshCw size={15} aria-hidden="true" /> Refresh
        </button>
      )}
    </header>
  );

  if (!canReview || permissionDenied) {
    return (
      <div className="page-container website-enquiries-page">
        {header}
        <div className="module-access-state" role="status">
          <ShieldAlert size={22} aria-hidden="true" />
          <h2>Only R&amp;M administrators can see website enquiries</h2>
          <p>Ask an R&amp;M administrator if you need to follow up an enquiry.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page-container website-enquiries-page">
      {header}

      <div className="website-enquiries-toolbar">
        <div className="website-enquiries-filters" role="group" aria-label="Show enquiries by status">
          {STATUS_FILTERS.map((filter) => (
            <button
              type="button"
              key={filter.value}
              className={`btn btn-sm ${statusFilter === filter.value ? 'btn-primary' : 'btn-secondary'}`}
              aria-pressed={statusFilter === filter.value}
              onClick={() => { setStatusFilter(filter.value); setPending(null); setActionError(null); }}
            >
              {filter.label}
            </button>
          ))}
        </div>
        <label className="website-enquiries-search">
          <span>Search enquiries</span>
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Name, organisation, reference or email"
          />
        </label>
      </div>

      {notice && (
        <div className="website-enquiries-notice" role="status">
          <span>{notice.message}</span>
          {notice.converted && (
            <span>
              Now set up the client in CRM so agreements and work can follow.{' '}
              <button type="button" className="btn btn-sm btn-primary" onClick={() => onNavigate('client-setup')}>Set up a new client</button>
            </span>
          )}
        </div>
      )}

      {loadError && (
        <div className="alert alert-error" role="alert">
          <span>Website enquiries could not be loaded. {loadError}</span>
          <button type="button" className="btn btn-sm btn-secondary" onClick={() => void loadEnquiries()}>Try again</button>
        </div>
      )}

      {loading ? (
        <div className="loading-state" role="status">
          <div className="spinner" aria-hidden="true" />
          <span>Loading website enquiries…</span>
        </div>
      ) : !loadError && visibleEnquiries.length === 0 ? (
        <div className="empty-state website-enquiries-empty">
          <Inbox size={22} aria-hidden="true" />
          <p>
            {searchTerm
              ? 'No enquiries match that search.'
              : statusFilter === 'all'
                ? 'No website enquiries yet. New enquiries from the website appear here.'
                : `No ${STATUS_LABELS[statusFilter as EnquiryStatus].toLowerCase()} enquiries.`}
          </p>
        </div>
      ) : (
        <>
          <p className="website-enquiries-count" aria-live="polite">
            {visibleEnquiries.length === 1 ? '1 enquiry' : `${visibleEnquiries.length} enquiries`}
            {enquiries.length >= PAGE_LIMIT ? ` (showing the newest ${PAGE_LIMIT})` : ''}
          </p>
          <ul className="website-enquiries-list" aria-label="Website enquiries">
            {visibleEnquiries.map((enquiry) => {
              const isExpanded = Boolean(expanded[enquiry.id]);
              const longMessage = enquiry.message.length > MESSAGE_PREVIEW_LENGTH;
              const shownMessage = longMessage && !isExpanded
                ? `${enquiry.message.slice(0, MESSAGE_PREVIEW_LENGTH).trimEnd()}…`
                : enquiry.message;
              const actions = actionsFor(enquiry.status);
              const pendingHere = pending?.enquiryId === enquiry.id ? pending.action : null;
              const noteId = `website-enquiry-note-${enquiry.id}`;
              return (
                <li key={enquiry.id} className="website-enquiry-card">
                  <div className="website-enquiry-heading">
                    <strong className="website-enquiry-reference">{enquiry.reference}</strong>
                    <span className={STATUS_BADGES[enquiry.status]}>{STATUS_LABELS[enquiry.status]}</span>
                    <span className="website-enquiry-received">Received {formatReceived(enquiry.received_at)}</span>
                  </div>

                  <dl className="website-enquiry-details">
                    <div>
                      <dt>From</dt>
                      <dd>{enquiry.name}{enquiry.organisation ? `, ${enquiry.organisation}` : ''}</dd>
                    </div>
                    <div>
                      <dt>Contact</dt>
                      <dd className="website-enquiry-contact">
                        {enquiry.email && <a href={`mailto:${enquiry.email}`}>{enquiry.email}</a>}
                        {enquiry.phone && <a href={`tel:${enquiry.phone.replace(/[^0-9+]/g, '')}`}>{enquiry.phone}</a>}
                        <small>{PREFERRED_CONTACT_LABELS[enquiry.preferred_contact] ?? PREFERRED_CONTACT_LABELS.either}</small>
                      </dd>
                    </div>
                    <div>
                      <dt>Location</dt>
                      <dd>{enquiry.location || 'Not given'}</dd>
                    </div>
                    <div>
                      <dt>Services</dt>
                      <dd>{enquiry.services && enquiry.services.length > 0
                        ? enquiry.services.map((service) => SERVICE_LABELS[service] ?? service).join(', ')
                        : 'Not given'}</dd>
                    </div>
                  </dl>

                  <div className="website-enquiry-message">
                    <p>{shownMessage}</p>
                    {longMessage && (
                      <button
                        type="button"
                        className="btn btn-sm btn-secondary"
                        aria-expanded={isExpanded}
                        onClick={() => setExpanded((current) => ({ ...current, [enquiry.id]: !isExpanded }))}
                      >
                        {isExpanded ? 'Show less' : 'Show full message'}
                      </button>
                    )}
                  </div>

                  {enquiry.status_note && (
                    <p className="website-enquiry-note">
                      <strong>Note:</strong> {enquiry.status_note}
                      {enquiry.handled_at ? ` (${formatReceived(enquiry.handled_at)})` : ''}
                    </p>
                  )}

                  {enquiry.status === 'converted' && (
                    <p className="website-enquiry-note">
                      Converted enquiries are final. Set up the client in CRM if that is not done yet.{' '}
                      <button type="button" className="btn btn-sm btn-secondary" onClick={() => onNavigate('client-setup')}>Set up a new client</button>
                    </p>
                  )}

                  {pendingHere ? (
                    <form
                      className="website-enquiry-action-form"
                      onSubmit={(event) => { event.preventDefault(); void submitAction(enquiry); }}
                    >
                      <div className="form-group">
                        <label htmlFor={noteId}>
                          {pendingHere.noteRequired ? `Note for "${pendingHere.label}" (required)` : `Note for "${pendingHere.label}" (optional)`}
                        </label>
                        <textarea
                          id={noteId}
                          value={note}
                          maxLength={2000}
                          rows={3}
                          required={pendingHere.noteRequired}
                          onChange={(event) => setNote(event.target.value)}
                          placeholder={pendingHere.noteRequired ? 'Say why, for example "Signed up as a client" or "Out of area".' : 'For example "Phoned, quote booked for Tuesday".'}
                        />
                      </div>
                      {pendingHere.status === 'converted' && (
                        <p className="website-enquiry-hint">This does not create a client. After saving, set up the client in CRM.</p>
                      )}
                      {actionError && (
                        <div className="alert alert-error" role="alert">
                          <span>{actionError.message}</span>
                          {actionError.stale && (
                            <button type="button" className="btn btn-sm btn-secondary" onClick={() => void reloadAfterConflict()}>Reload</button>
                          )}
                        </div>
                      )}
                      <div className="website-enquiry-actions">
                        <button type="submit" className="btn btn-sm btn-primary" disabled={saving}>
                          {saving ? 'Saving…' : `Save: ${pendingHere.label}`}
                        </button>
                        <button type="button" className="btn btn-sm btn-secondary" onClick={cancelAction} disabled={saving}>Cancel</button>
                      </div>
                    </form>
                  ) : actions.length > 0 && (
                    <div className="website-enquiry-actions" role="group" aria-label={`Actions for ${enquiry.reference}`}>
                      {actions.map((action) => (
                        <button
                          type="button"
                          key={`${action.status}:${action.label}`}
                          className={`btn btn-sm ${action.status === 'spam' ? 'btn-danger' : action === MARK_CONTACTED ? 'btn-primary' : 'btn-secondary'}`}
                          onClick={() => startAction(enquiry, action)}
                        >
                          {action.label}
                        </button>
                      ))}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
