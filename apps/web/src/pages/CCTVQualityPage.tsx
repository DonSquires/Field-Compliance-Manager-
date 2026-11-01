import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Car, Check, Cloud, ExternalLink, EyeOff, Gauge, ListChecks, Loader2, PawPrint, RefreshCw, ShieldCheck, UserRound, X } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import { isAdminTierRole } from '../lib/roles';
import { asRecord, describeConsoleFailure, formatClock, formatDate, type ConsoleFailure, type EntityKind } from '../lib/cctvConsole';
import {
  accuracyByKind,
  basisLabel,
  calibrationLabel,
  CURRENT_ENGINE_VERSION,
  engineLabel,
  parseAccuracySummary,
  percent,
  type AccuracySummary,
} from '../lib/cctvQuality';
import './PageStyles.css';
import './CCTVConsolePage.css';
import './CCTVTriagePage.css';
import './CCTVQualityPage.css';

type Period = 30 | 90 | 365;
const sinceFor = (days: Period) => new Date(Date.now() - days * 86_400_000).toISOString();
type QualityError = ConsoleFailure & { retry: (() => void) | null };
type ReportState = 'open' | 'confirmed_missed' | 'not_missed';
type MissedReport = {
  id: string;
  kind: EntityKind;
  importId: string | null;
  fileName: string;
  offsetSeconds: number | null;
  observedAt: string | null;
  notes: string | null;
  engineVersion: string;
  state: ReportState;
  reportedAt: string;
  resolutionNotes: string | null;
};
type Policy = { enabled: boolean; model: string | null; reason: string | null; setAt: string | null };
type ResolveDraft = { id: string; state: 'confirmed_missed' | 'not_missed'; notes: string };

const TIME_ZONE = 'Pacific/Auckland';
const PERIODS: Period[] = [30, 90, 365];
const DEFAULT_CLOUD_MODEL = 'gemma4:31b';
const KIND_ICON: Record<EntityKind, React.ReactNode> = {
  person: <UserRound size={16} aria-hidden="true" />,
  vehicle: <Car size={16} aria-hidden="true" />,
  animal: <PawPrint size={16} aria-hidden="true" />,
};
const KIND_LABEL: Record<EntityKind, string> = { person: 'People', vehicle: 'Vehicles', animal: 'Animals' };
const STATE_LABEL: Record<ReportState, string> = { open: 'Waiting for an administrator', confirmed_missed: 'Confirmed miss', not_missed: 'Not a miss' };

function describeFailure(message: string, scope: string): ConsoleFailure {
  // Before the inference migration reaches an environment the RPC does not exist yet; say so plainly.
  if (/could not find the function|pgrst202|does not exist/i.test(message)) {
    return { kind: 'other', text: `Detection quality measurement is not installed on this environment yet, so there is nothing to show. Nothing was changed.`, retryable: true };
  }
  return describeConsoleFailure(message, scope, navigator.onLine);
}

function toReport(row: Record<string, unknown>): MissedReport | null {
  const kind = row.entity_kind;
  if (typeof row.id !== 'string' || (kind !== 'person' && kind !== 'vehicle' && kind !== 'animal')) return null;
  const evidence = asRecord(Array.isArray(row.evidence_items) ? row.evidence_items[0] : row.evidence_items);
  const metadata = asRecord(evidence.metadata);
  const storagePath = typeof evidence.storage_path === 'string' ? evidence.storage_path : '';
  const state = row.state === 'confirmed_missed' || row.state === 'not_missed' ? row.state : 'open';
  const offset = row.offset_seconds === null || row.offset_seconds === undefined ? null : Number(row.offset_seconds);
  return {
    id: row.id,
    kind,
    importId: typeof evidence.cctv_import_id === 'string' ? evidence.cctv_import_id : null,
    fileName: typeof metadata.file_name === 'string' ? metadata.file_name : storagePath.split('/').pop() || 'Recording',
    offsetSeconds: offset !== null && Number.isFinite(offset) ? offset : null,
    observedAt: typeof row.observed_at === 'string' ? row.observed_at : null,
    notes: typeof row.notes === 'string' && row.notes.trim() ? row.notes : null,
    engineVersion: typeof row.engine_version === 'string' ? row.engine_version : 'legacy',
    state,
    reportedAt: typeof row.reported_at === 'string' ? row.reported_at : new Date(0).toISOString(),
    resolutionNotes: typeof row.resolution_notes === 'string' && row.resolution_notes.trim() ? row.resolution_notes : null,
  };
}

const ms = (iso: string | null) => (iso ? new Date(iso).getTime() : 0);

const CCTVQualityPage: React.FC = () => {
  const { profile } = useAuth();
  const navigate = useNavigate();
  const organizationId = profile?.organizationId ?? null;
  const isAdmin = isAdminTierRole(profile?.role);

  const [period, setPeriod] = useState<Period>(90);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<QualityError | null>(null);
  const [summary, setSummary] = useState<AccuracySummary | null>(null);
  const [reports, setReports] = useState<MissedReport[]>([]);
  const [reportsError, setReportsError] = useState<string | null>(null);
  const [policy, setPolicy] = useState<Policy>({ enabled: false, model: null, reason: null, setAt: null });
  const [policyError, setPolicyError] = useState<string | null>(null);
  const [cloudSends, setCloudSends] = useState<number | null>(null);

  const [resolveDraft, setResolveDraft] = useState<ResolveDraft | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [policyDraft, setPolicyDraft] = useState<{ enabled: boolean; model: string; reason: string } | null>(null);

  // Each load supersedes the one before it: a slow 90-day answer must not overwrite a newer 30-day one, nor a
  // previous organisation's answer the current one.
  const loadGeneration = useRef(0);

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    if (!organizationId) {
      setLoading(false);
      setError({ kind: 'permission', text: 'Organisation access could not be confirmed, so detection quality is unavailable.', retryable: false, retry: null });
      return;
    }
    setLoading(true);
    const since = sinceFor(period);
    const [summaryRes, reportsRes, policyRes, receiptsRes] = await Promise.all([
      supabase.rpc('cctv_accuracy_summary', { p_organization_id: organizationId, p_since: since }),
      supabase
        .from('cctv_missed_detection_reports')
        .select('id, entity_kind, offset_seconds, observed_at, notes, engine_version, state, reported_at, resolution_notes, evidence_items(cctv_import_id, storage_path, metadata)')
        .eq('organization_id', organizationId)
        .gte('reported_at', since)
        .order('reported_at', { ascending: false })
        .limit(100),
      supabase.from('cctv_inference_policies').select('cloud_vehicle_vlm_enabled, cloud_vehicle_vlm_model, reason, set_at').eq('organization_id', organizationId).maybeSingle(),
      supabase.from('cctv_cloud_inference_receipts').select('id', { count: 'exact', head: true }).eq('organization_id', organizationId).gte('created_at', since),
    ]);
    if (generation !== loadGeneration.current) return;
    setLoading(false);
    if (summaryRes.error) {
      setError({ ...describeFailure(summaryRes.error.message, 'detection quality'), retry: () => void load() });
      return;
    }
    setError(null);
    setSummary(parseAccuracySummary(summaryRes.data));
    setReportsError(reportsRes.error ? reportsRes.error.message : null);
    setReports(((reportsRes.data as unknown as Record<string, unknown>[]) ?? []).map(toReport).filter((row): row is MissedReport => row !== null));
    if (policyRes.error) {
      setPolicyError(policyRes.error.message);
    } else {
      const row = asRecord(policyRes.data);
      setPolicyError(null);
      setPolicy({
        enabled: row.cloud_vehicle_vlm_enabled === true,
        model: typeof row.cloud_vehicle_vlm_model === 'string' ? row.cloud_vehicle_vlm_model : null,
        reason: typeof row.reason === 'string' ? row.reason : null,
        setAt: typeof row.set_at === 'string' ? row.set_at : null,
      });
    }
    setCloudSends(receiptsRes.error ? null : receiptsRes.count ?? 0);
  }, [organizationId, period]);

  useEffect(() => { void load(); }, [load]);

  // The per-kind cards come from the governed summary, so a resolved report is reflected by reading it again.
  const refreshSummary = async (): Promise<string | null> => {
    if (!organizationId) return null;
    const generation = loadGeneration.current;
    const since = sinceFor(period);
    const { data, error: summaryError } = await supabase.rpc('cctv_accuracy_summary', { p_organization_id: organizationId, p_since: since });
    if (generation !== loadGeneration.current) return null;
    if (summaryError) return summaryError.message;
    setSummary(parseAccuracySummary(data));
    return null;
  };

  const kinds = useMemo(() => (summary ? accuracyByKind(summary, CURRENT_ENGINE_VERSION) : []), [summary]);
  const legacyKinds = useMemo(() => (summary ? accuracyByKind(summary, 'legacy') : []), [summary]);
  const groups = useMemo(() => (summary?.groups ?? []).slice().sort((a, b) => (
    (a.engineVersion === CURRENT_ENGINE_VERSION ? 0 : 1) - (b.engineVersion === CURRENT_ENGINE_VERSION ? 0 : 1)
    || a.entityKind.localeCompare(b.entityKind)
    || b.decided - a.decided
  )), [summary]);
  const orderedReports = useMemo(() => reports.slice().sort((a, b) => (
    (a.state === 'open' ? 0 : 1) - (b.state === 'open' ? 0 : 1) || ms(b.reportedAt) - ms(a.reportedAt)
  )), [reports]);
  const openReports = reports.filter((report) => report.state === 'open').length;
  const hasCurrentEngineData = kinds.some((kind) => kind.total > 0);

  const saveResolution = async () => {
    if (!resolveDraft) return;
    setBusy(`resolve:${resolveDraft.id}`);
    setMessage(null);
    const { error: resolveError } = await supabase.rpc('resolve_cctv_missed_detection', {
      p_report_id: resolveDraft.id,
      p_state: resolveDraft.state,
      p_notes: resolveDraft.notes.trim() || null,
    });
    setBusy(null);
    if (resolveError) { setMessage(resolveError.message); return; }
    setReports((current) => current.map((report) => (report.id === resolveDraft.id ? { ...report, state: resolveDraft.state, resolutionNotes: resolveDraft.notes.trim() || null } : report)));
    const recorded = resolveDraft.state === 'confirmed_missed' ? 'Recorded as a confirmed miss. It now counts against detection quality.' : 'Recorded as not a miss. The report is kept for the record and does not count.';
    setMessage(recorded);
    setResolveDraft(null);
    const refreshError = await refreshSummary();
    if (refreshError) setMessage(`${recorded} The quality figures could not be refreshed (${refreshError}); use Refresh to update them.`);
  };

  const savePolicy = async () => {
    if (!policyDraft || !organizationId) return;
    if (policyDraft.enabled && !policyDraft.reason.trim()) { setMessage('Give a reason before allowing cloud vehicle hints.'); return; }
    setBusy('policy');
    setMessage(null);
    const { data, error: saveError } = await supabase.rpc('set_cctv_inference_policy', {
      p_organization_id: organizationId,
      p_cloud_vehicle_vlm_enabled: policyDraft.enabled,
      p_cloud_vehicle_vlm_model: policyDraft.enabled ? policyDraft.model.trim() || null : null,
      p_reason: policyDraft.reason.trim() || null,
    });
    setBusy(null);
    if (saveError) { setMessage(saveError.message); return; }
    const row = asRecord(data);
    setPolicy({
      enabled: row.cloud_vehicle_vlm_enabled === true,
      model: typeof row.cloud_vehicle_vlm_model === 'string' ? row.cloud_vehicle_vlm_model : null,
      reason: typeof row.reason === 'string' ? row.reason : null,
      setAt: typeof row.set_at === 'string' ? row.set_at : new Date().toISOString(),
    });
    setPolicyDraft(null);
    setMessage(row.cloud_vehicle_vlm_enabled === true ? 'Cloud vehicle hints allowed. The change is in the audit trail.' : 'Cloud vehicle hints turned off. The change is in the audit trail.');
  };

  return (
    <div className="page-container cctv-console cctv-triage cctv-quality">
      <header className="cctv-triage__header">
        <div>
          <h1 className="page-title"><Gauge size={20} aria-hidden="true" /> Detection quality</h1>
          <p className="page-subtitle">How often the CCTV engine is right, measured only from reviewers' decisions. Use it to judge how far to trust a sighting before acting on it.</p>
        </div>
        <div className="cctv-triage__header-actions">
          <div className="cctv-quality__periods" role="group" aria-label="Period">
            {PERIODS.map((option) => <button key={option} type="button" className={`cctv-console__chip${period === option ? ' is-on' : ''}`} aria-pressed={period === option} onClick={() => setPeriod(option)}>{option === 365 ? '12 months' : `${option} days`}</button>)}
          </div>
          <button type="button" className="page-action" onClick={() => navigate('/admin/field-ops?area=cctv-triage')}><ListChecks size={14} aria-hidden="true" /> Review queue</button>
          <button type="button" className="page-action" onClick={() => void load()} disabled={loading}><RefreshCw size={14} aria-hidden="true" /> Refresh</button>
        </div>
      </header>

      {error ? (
        <div className="cctv-triage__error" role="alert">
          <span>{error.text}</span>
          {error.retryable && error.retry ? <button type="button" className="page-action" onClick={error.retry}>Retry</button> : null}
        </div>
      ) : null}
      {message ? <p className="cctv-quality__message" role="status">{message}</p> : null}
      {loading && !summary ? <p className="cctv-console__muted"><Loader2 size={14} className="spin" aria-hidden="true" /> Loading detection quality…</p> : null}

      {summary ? (
        <>
          <section className="cctv-quality__section" aria-labelledby="cctv-quality-current">
            <div className="cctv-quality__section-head">
              <h2 id="cctv-quality-current">{engineLabel(CURRENT_ENGINE_VERSION)} · last {period === 365 ? '12 months' : `${period} days`}</h2>
              <p className="cctv-console__muted">Precision is the share of sightings a reviewer accepted. The lower bound is what the engine has proven with 95% confidence; it rises as more sightings are decided. A kind is calibrated once {summary.calibrationMinimum} sightings have been accepted or rejected.</p>
            </div>
            {!hasCurrentEngineData ? (
              <p className="cctv-quality__empty">The current engine has not produced sightings in this period yet. Footage processed after the upgrade, or reprocessed, will appear here once reviewers decide its sightings.</p>
            ) : null}
            <div className="cctv-quality__cards">
              {kinds.map((kind) => (
                <article key={kind.entityKind} className={`cctv-quality__card${kind.calibrated ? ' is-calibrated' : ''}`} aria-label={`${KIND_LABEL[kind.entityKind]} detection quality`}>
                  <header>{KIND_ICON[kind.entityKind]}<strong>{KIND_LABEL[kind.entityKind]}</strong><span className={`cctv-quality__badge${kind.calibrated ? ' is-on' : ''}`}>{calibrationLabel(kind.decided, summary.calibrationMinimum)}</span></header>
                  <div className="cctv-quality__figure">
                    <span><b>{percent(kind.precisionLowerBound)}</b><small>proven precision (lower bound)</small></span>
                    <span><b>{percent(kind.precision)}</b><small>accepted of decided</small></span>
                  </div>
                  <dl>
                    <div><dt>Decided</dt><dd>{kind.decided}</dd></div>
                    <div><dt>Waiting for review</dt><dd>{kind.pending}</dd></div>
                    <div><dt>Confirmed misses</dt><dd>{kind.confirmedMissed}{kind.openMissed ? ` · ${kind.openMissed} to check` : ''}</dd></div>
                  </dl>
                </article>
              ))}
            </div>
            {legacyKinds.some((kind) => kind.decided > 0) ? (
              <p className="cctv-console__muted cctv-quality__legacy">
                For comparison, {engineLabel('legacy')}: {legacyKinds.filter((kind) => kind.decided > 0).map((kind) => `${KIND_LABEL[kind.entityKind].toLowerCase()} ${percent(kind.precision)} of ${kind.decided} decided`).join(' · ')}.
              </p>
            ) : null}
          </section>

          <section className="cctv-quality__section" aria-labelledby="cctv-quality-breakdown">
            <div className="cctv-quality__section-head">
              <h2 id="cctv-quality-breakdown">Where the engine is strong and weak</h2>
              <p className="cctv-console__muted">Each row is one kind of sighting, split by why it was put in front of a reviewer and how confident the detector was. Low proven precision on a well-reviewed row is the signal to tighten that path.</p>
            </div>
            {groups.length === 0 ? <p className="cctv-quality__empty">No sightings were recorded in this period.</p> : (
              <div className="cctv-quality__table-wrap">
                <table className="cctv-quality__table">
                  <thead><tr><th scope="col">Kind</th><th scope="col">Engine</th><th scope="col">Why reviewed</th><th scope="col">Confidence</th><th scope="col">Decided</th><th scope="col">Precision</th><th scope="col">Proven</th><th scope="col">Waiting</th></tr></thead>
                  <tbody>
                    {groups.map((group) => (
                      <tr key={`${group.entityKind}-${group.engineVersion}-${group.detectorModel}-${group.reviewBasis}-${group.confidenceBand}`}>
                        <td>{group.entityKind}</td>
                        <td title={group.detectorModel}>{engineLabel(group.engineVersion)}</td>
                        <td>{group.reviewBasis === 'unrecorded' ? 'not recorded' : basisLabel(group.reviewBasis)}</td>
                        <td>{group.confidenceBand}</td>
                        <td>{group.decided}{group.inconclusive ? <small> +{group.inconclusive} unsure</small> : null}</td>
                        <td>{percent(group.precision)}</td>
                        <td><span className={`cctv-quality__badge${group.calibrated ? ' is-on' : ''}`} title={calibrationLabel(group.decided, summary.calibrationMinimum)}>{percent(group.precisionLowerBound)}</span></td>
                        <td>{group.pending}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="cctv-quality__section" aria-labelledby="cctv-quality-missed">
            <div className="cctv-quality__section-head">
              <h2 id="cctv-quality-missed"><EyeOff size={16} aria-hidden="true" /> Missed sightings <em>{openReports} to check</em></h2>
              <p className="cctv-console__muted">Reviewers report a person, vehicle or animal the engine did not pick up from the console's Missed button. {isAdmin ? 'Check each against the footage; only a confirmed miss counts against quality.' : 'An administrator checks each against the footage; only a confirmed miss counts against quality.'}</p>
            </div>
            {reportsError ? <p className="cctv-triage__error" role="alert">Missed-sighting reports could not be loaded: {reportsError}</p> : null}
            {!reportsError && orderedReports.length === 0 ? <p className="cctv-quality__empty">No missed sightings were reported in this period.</p> : null}
            <ul className="cctv-quality__reports">
              {orderedReports.map((report) => (
                <li key={report.id} className={`cctv-quality__report is-${report.state}`}>
                  <span className="cctv-quality__report-icon">{KIND_ICON[report.kind]}</span>
                  <div className="cctv-quality__report-body">
                    <strong>Missed {report.kind} · {report.fileName}{report.offsetSeconds !== null ? ` · ${report.offsetSeconds.toFixed(1)} s in` : ''}</strong>
                    <small>{report.observedAt ? `At ${formatDate(ms(report.observedAt), TIME_ZONE)} ${formatClock(ms(report.observedAt), TIME_ZONE)} · ` : ''}reported {formatDate(ms(report.reportedAt), TIME_ZONE)} · {engineLabel(report.engineVersion)}</small>
                    {report.notes ? <p>{report.notes}</p> : null}
                    <span className={`cctv-quality__state is-${report.state}`}>{STATE_LABEL[report.state]}{report.resolutionNotes ? ` · ${report.resolutionNotes}` : ''}</span>
                    {resolveDraft?.id === report.id ? (
                      <form className="cctv-quality__resolve" onSubmit={(event) => { event.preventDefault(); void saveResolution(); }} aria-label="Resolve missed sighting">
                        <fieldset>
                          <legend>After checking the footage</legend>
                          <label><input type="radio" name={`resolve-${report.id}`} checked={resolveDraft.state === 'confirmed_missed'} onChange={() => setResolveDraft({ ...resolveDraft, state: 'confirmed_missed' })} /> The engine missed it</label>
                          <label><input type="radio" name={`resolve-${report.id}`} checked={resolveDraft.state === 'not_missed'} onChange={() => setResolveDraft({ ...resolveDraft, state: 'not_missed' })} /> It was not a miss</label>
                        </fieldset>
                        <label className="cctv-entity__field">Note <input value={resolveDraft.notes} onChange={(event) => setResolveDraft({ ...resolveDraft, notes: event.target.value })} maxLength={2000} placeholder="Optional, e.g. person fully behind the gate post" /></label>
                        <p className="cctv-console__muted">A resolution is recorded once, against your account, and cannot be changed here.</p>
                        <div className="cctv-entity__actions">
                          <button type="submit" className="page-action is-primary" disabled={busy !== null}><Check size={14} aria-hidden="true" /> Save resolution</button>
                          <button type="button" className="page-action" onClick={() => setResolveDraft(null)}>Cancel</button>
                        </div>
                      </form>
                    ) : null}
                  </div>
                  <div className="cctv-quality__report-actions">
                    {report.importId ? <button type="button" className="page-action" onClick={() => navigate(`/admin/field-ops?area=cctv-console&import=${report.importId}`)}><ExternalLink size={14} aria-hidden="true" /> Watch footage</button> : null}
                    {isAdmin && report.state === 'open' && resolveDraft?.id !== report.id ? <button type="button" className="page-action" onClick={() => setResolveDraft({ id: report.id, state: 'confirmed_missed', notes: '' })}>Resolve…</button> : null}
                  </div>
                </li>
              ))}
            </ul>
          </section>

          <section className="cctv-quality__section" aria-labelledby="cctv-quality-cloud">
            <div className="cctv-quality__section-head">
              <h2 id="cctv-quality-cloud"><Cloud size={16} aria-hidden="true" /> Cloud vehicle hints</h2>
              <p className="cctv-console__muted">Make and model suggestions come from the local vision model. If your organisation allows it, a cloud model is asked only when the local one cannot answer, and only with a vehicle crop that has no person in it and every number plate blacked out. A receipt holding the crop's fingerprint, never the picture, is written before each send. Suggestions stay unconfirmed until a reviewer confirms them.</p>
            </div>
            {policyError ? <p className="cctv-triage__error" role="alert">The cloud policy could not be loaded: {policyError}</p> : null}
            <div className="cctv-quality__policy">
              <ShieldCheck size={18} aria-hidden="true" />
              <div>
                <strong>{policy.enabled ? `Allowed · ${policy.model ?? DEFAULT_CLOUD_MODEL}` : 'Off · nothing leaves your infrastructure'}</strong>
                <small>
                  {policy.setAt ? `Set ${formatDate(ms(policy.setAt), TIME_ZONE)}` : 'Never changed; off by default'}
                  {policy.reason ? ` · reason: ${policy.reason}` : ''}
                  {cloudSends !== null ? ` · ${cloudSends} crop${cloudSends === 1 ? '' : 's'} sent in this period` : ''}
                </small>
              </div>
              {isAdmin && !policyDraft ? <button type="button" className="page-action" onClick={() => setPolicyDraft({ enabled: policy.enabled, model: policy.model ?? DEFAULT_CLOUD_MODEL, reason: '' })}>Change…</button> : null}
            </div>
            {!isAdmin ? <p className="cctv-console__muted">Only an organisation administrator can change this.</p> : null}
            {policyDraft ? (
              <form className="cctv-quality__policy-form" onSubmit={(event) => { event.preventDefault(); void savePolicy(); }} aria-label="Cloud vehicle hint policy">
                <label className="cctv-console__toggle"><input type="checkbox" checked={policyDraft.enabled} onChange={(event) => setPolicyDraft({ ...policyDraft, enabled: event.target.checked })} /> Allow cloud vehicle make and model hints</label>
                {policyDraft.enabled ? <label className="cctv-entity__field">Cloud model <input value={policyDraft.model} onChange={(event) => setPolicyDraft({ ...policyDraft, model: event.target.value })} maxLength={80} placeholder={DEFAULT_CLOUD_MODEL} /></label> : null}
                <label className="cctv-entity__field">Reason {policyDraft.enabled ? '(required)' : '(optional)'} <textarea value={policyDraft.reason} onChange={(event) => setPolicyDraft({ ...policyDraft, reason: event.target.value })} rows={2} placeholder="Why this organisation needs it, e.g. vehicle-heavy sites where the laptop is often offline" required={policyDraft.enabled} /></label>
                <div className="cctv-entity__actions">
                  <button type="submit" className="page-action is-primary" disabled={busy !== null || (policyDraft.enabled && !policyDraft.reason.trim())}><Check size={14} aria-hidden="true" /> Save policy</button>
                  <button type="button" className="page-action" onClick={() => setPolicyDraft(null)}><X size={14} aria-hidden="true" /> Cancel</button>
                </div>
              </form>
            ) : null}
          </section>
        </>
      ) : null}
    </div>
  );
};

export default CCTVQualityPage;
