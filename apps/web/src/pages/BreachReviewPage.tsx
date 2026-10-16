/**
 * BreachReviewPage.tsx (Admin field-ops sub-area: 'breach-review')
 *
 * Canonical schema: breach_alerts (org-wide triage queue, status in
 * open/acknowledged/actioned/dismissed/resolved/exempt_homeless), joined with:
 * - location_zones (zone name and compliance rule thresholds)
 * - observations (photo_url, is_scv, observed_at evidence)
 * - user_profiles (actioned_by officer display name)
 */

import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useServiceRelationships } from '../context/ServiceRelationshipContext';
import { supabase } from '../lib/supabase';
import { NoticePrintActions } from '../components/NoticePrintActions';
import { GeneratedArtifactActions } from '../components/GeneratedArtifactActions';
import type { NoticeReceiptData } from '../lib/thermalReceipt';
import './PageStyles.css';
import './BreachReviewPage.css';

type ActionType =
  | 'verbal_warning'
  | 'written_warning'
  | 'notice_to_vacate'
  | 'infringement'
  | 'tow_request'
  | 'welfare_referral'
  | 'approve_requested'
  | 'dismissed'
  | 'resolved'
  | 'exempt_homeless';

interface BreachAlert {
  id: string;
  plate_number: string;
  breach_type: string;
  status: string;
  nights_count: number | null;
  limit_value: number | null;
  notes: string | null;
  created_at: string;
  action_type: string | null;
  actioned_at: string | null;
  requested_action: string | null;
  requested_at: string | null;
  request_notes: string | null;
  enforcement_mode: string | null;
  request_disposition: string | null;
  zone_name: string | null;
  observation_date: string | null;
  is_scv: boolean | null;
  photo_url: string | null;
}

const ACTION_OPTIONS: { type: ActionType; label: string; btnClass: string }[] = [
  { type: 'verbal_warning', label: '🗣️ Verbal Warning', btnClass: 'btn-secondary' },
  { type: 'written_warning', label: '📄 Written Warning', btnClass: 'btn-secondary' },
  { type: 'notice_to_vacate', label: '🚪 Notice to Vacate', btnClass: 'btn-secondary' },
  { type: 'infringement', label: '🎫 Issue Infringement', btnClass: 'btn-secondary' },
  { type: 'tow_request', label: '🚛 Tow Request', btnClass: 'btn-secondary' },
  { type: 'welfare_referral', label: '🤝 Welfare Referral', btnClass: 'btn-secondary' },
  { type: 'dismissed', label: '✕ Dismiss', btnClass: 'btn-danger' },
];

const BreachReviewPage: React.FC = () => {
  const navigate = useNavigate();
  const { profile, operatingOrganizationId } = useAuth();
  const { selectedAgreementZones } = useServiceRelationships();
  const [alerts, setAlerts] = useState<BreachAlert[]>([]);
  const [statusFilter, setStatusFilter] = useState<'open' | 'acknowledged' | 'actioned' | 'dismissed' | 'resolved' | 'exempt_homeless' | 'all'>('open');
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [activeActionAlertId, setActiveActionAlertId] = useState<string | null>(null);
  const [actionNotes, setActionNotes] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [generatingNoticeId, setGeneratingNoticeId] = useState<string | null>(null);
  const [noticeReceipts, setNoticeReceipts] = useState<Record<string, NoticeReceiptData>>({});
  const [noticePreviews, setNoticePreviews] = useState<Record<string, NoticeReceiptData>>({});
  const [typedAuthorizerNames, setTypedAuthorizerNames] = useState<Record<string, string>>({});
  const [printRequestIds, setPrintRequestIds] = useState<Record<string, string>>({});
  const [noticeArtifactPaths, setNoticeArtifactPaths] = useState<Record<string, string>>({});

  // ATLAS READS: breach_alerts, location_zones, observations
  const loadAlerts = useCallback(async () => {
    const orgId = operatingOrganizationId ?? profile?.organizationId;
    if (!orgId) {
      setAlerts([]);
      setError('Organisation access could not be confirmed. Breach review is unavailable.');
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      setError(null);

      let query = supabase
        .from('breach_alerts')
        .select(
          'id, plate_number, breach_type, status, nights_count, limit_value, notes, created_at, action_type, actioned_at, zone_id, requested_action, requested_at, request_notes, enforcement_mode, request_disposition'
        )
        .eq('organization_id', orgId);

      if (selectedAgreementZones.length > 0) {
        query = query.in('zone_id', selectedAgreementZones.map((zone) => zone.id));
      }

      if (statusFilter !== 'all') {
        query = query.eq('status', statusFilter);
      }

      const { data, error: err } = await query.order('created_at', { ascending: false }).limit(100);

      if (err) throw err;

      setAlerts(
        ((data as any[]) || []).map((row) => ({
          id: row.id,
          plate_number: row.plate_number,
          breach_type: row.breach_type,
          status: row.status,
          nights_count: row.nights_count,
          limit_value: row.limit_value,
          notes: row.notes,
          created_at: row.created_at,
          action_type: row.action_type,
          actioned_at: row.actioned_at,
          requested_action: row.requested_action,
          requested_at: row.requested_at,
          request_notes: row.request_notes,
          enforcement_mode: row.enforcement_mode,
          request_disposition: row.request_disposition,
          zone_name: row.zone?.name ?? null,
          observation_date: row.observation?.observed_at ?? null,
          is_scv: row.observation?.is_scv ?? null,
          photo_url: row.observation?.photo_url ?? null,
        }))
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load breach alerts');
    } finally {
      setLoading(false);
    }
  }, [operatingOrganizationId, profile?.organizationId, selectedAgreementZones, statusFilter]);

  useEffect(() => {
    loadAlerts();
  }, [loadAlerts]);

  const handleAction = async (alert: BreachAlert, actionType: ActionType) => {
    if (!profile?.id) return;
    try {
      setBusyId(alert.id);
      setError(null);

      const { data, error: updateErr } = await supabase.rpc('manage_breach_alert', { p_alert_id: alert.id, p_expected_status: alert.status, p_action: actionType, p_notes: actionNotes.trim() });

      const receipt=(data as Array<{alert_status:string;action_type:string|null;actioned_at:string}>|null)?.[0];if (updateErr||!receipt) throw updateErr??new Error('Breach decision receipt was not confirmed.');

      if (statusFilter !== 'all' && receipt.alert_status !== statusFilter) {
        setAlerts((prev) => prev.filter((a) => a.id !== alert.id));
      } else {
        setAlerts((prev) =>
          prev.map((a) =>
            a.id === alert.id
              ? {
                  ...a,
                  status: receipt.alert_status,
                  action_type: receipt.action_type,
                  actioned_at: receipt.actioned_at,
                  notes: actionNotes.trim(),
                }
              : a
          )
        );
      }
      setActiveActionAlertId(null);
      setActionNotes('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to action breach');
    } finally {
      setBusyId(null);
    }
  };

  const generateNoticeDraft = async (alert: BreachAlert) => {
    if (!profile?.displayName || !alert.action_type) return;
    setGeneratingNoticeId(alert.id);
    setError(null);
    const { data, error: invokeError } = await supabase.functions.invoke<{ html?: string; preview?: boolean; receipt?: NoticeReceiptData }>('generate-notice', {
      body: {
        operation: 'preview',
        notice_type: alert.action_type,
        breach_alert_id: alert.id,
        officer_name: profile.displayName,
        location_name: alert.zone_name,
        additional_notes: alert.notes,
      },
    });
    if (invokeError || !data?.html) {
      setError(invokeError?.message ?? 'The notice draft was not generated. Refresh and try again.');
    } else {
      if (data.receipt) setNoticePreviews((current) => ({ ...current, [alert.id]: data.receipt as NoticeReceiptData }));
      setPrintRequestIds((current) => ({ ...current, [alert.id]: current[alert.id] ?? crypto.randomUUID() }));
      const draftUrl = URL.createObjectURL(new Blob([data.html], { type: 'text/html' }));
      window.open(draftUrl, '_blank', 'noopener,noreferrer');
      window.setTimeout(() => URL.revokeObjectURL(draftUrl), 60_000);
    }

    setGeneratingNoticeId(null);
  };

  const authorizeNoticePrint = async (alert: BreachAlert) => {
    if (!profile?.displayName || !alert.action_type) return;
    setGeneratingNoticeId(alert.id);
    setError(null);
    const { data, error: invokeError } = await supabase.functions.invoke<{
      html?: string;
      pdf_url?: string;
      receipt?: NoticeReceiptData;
      authorization_receipt?: { id: string; created_at: string };
    }>('generate-notice', {
      body: {
        operation: 'authorize_print',
        notice_type: alert.action_type,
        breach_alert_id: alert.id,
        officer_name: profile.displayName,
        typed_name: typedAuthorizerNames[alert.id] ?? '',
        print_request_id: printRequestIds[alert.id],
        location_name: alert.zone_name,
        additional_notes: alert.notes,
      },
    });
    if (invokeError || !data?.pdf_url || !data.receipt || !data.authorization_receipt) {
      setError(invokeError?.message ?? 'Print authorization was not confirmed. No issued notice receipt is available.');
    } else {
      setNoticeReceipts((current) => ({ ...current, [alert.id]: data.receipt as NoticeReceiptData }));
      setNoticeArtifactPaths((current) => ({ ...current, [alert.id]: data.pdf_url as string }));
    }
    setGeneratingNoticeId(null);
  };

  const draftBobDocument = (alert: BreachAlert) => {
    const sourceType = alert.action_type === 'written_warning' || alert.action_type === 'notice_to_vacate' || alert.action_type === 'infringement' ? 'notice' : 'breach';
    navigate(`/admin/document-studio?sourceType=${sourceType}&sourceId=${alert.id}&auto=1`);
  };

  const filteredAlerts = useMemo(() => {
    if (typeFilter === 'all') return alerts;
    return alerts.filter((a) => a.breach_type === typeFilter);
  }, [alerts, typeFilter]);

  const uniqueBreachTypes = useMemo(() => {
    const types = new Set<string>();
    alerts.forEach((a) => types.add(a.breach_type));
    return Array.from(types);
  }, [alerts]);

  if (loading && alerts.length === 0) {
    return (
      <div className="page-container">
        <div className="loading-state">
          <div className="spinner"></div>
          <p>Loading breach triage queue...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page-container breach-review-page">
      <header className="page-header">
        <h1>Compliance Breach Review</h1>
        <p className="subtitle">Triage open vehicle infractions, issue enforcement notices, and manage legal actions</p>
      </header>

      {error && (
        <div className="alert alert-error" role="alert">
          <button className="alert-close" onClick={() => setError(null)} aria-label="Close alert">
            ×
          </button>
          {error}
        </div>
      )}

      {/* KPI Triage summary & filter controls */}
      <div className="breach-review-toolbar" style={{ marginTop: '16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px' }}>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
          <button
            className={`btn btn-sm ${statusFilter === 'open' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setStatusFilter('open')}
          >
            Open
          </button>
          <button
            className={`btn btn-sm ${statusFilter === 'acknowledged' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setStatusFilter('acknowledged')}
          >
            Acknowledged
          </button>
          <button
            className={`btn btn-sm ${statusFilter === 'actioned' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setStatusFilter('actioned')}
          >
            Actioned
          </button>
          <button
            className={`btn btn-sm ${statusFilter === 'dismissed' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setStatusFilter('dismissed')}
          >
            Dismissed
          </button>
          <button
            className={`btn btn-sm ${statusFilter === 'resolved' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setStatusFilter('resolved')}
          >
            Resolved
          </button>
          <button
            className={`btn btn-sm ${statusFilter === 'exempt_homeless' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setStatusFilter('exempt_homeless')}
          >
            Exempt - Homeless
          </button>
          <button
            className={`btn btn-sm ${statusFilter === 'all' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setStatusFilter('all')}
          >
            All History
          </button>
        </div>

        {uniqueBreachTypes.length > 1 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '12px', color: 'var(--color-text-secondary)' }}>Type:</span>
            <select
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
              style={{
                padding: '6px 10px',
                borderRadius: '6px',
                border: '1px solid var(--color-border)',
                background: 'var(--color-bg-secondary)',
                color: 'var(--color-text-primary)',
                fontSize: '12px',
              }}
            >
              <option value="all">All Breach Types ({alerts.length})</option>
              {uniqueBreachTypes.map((t) => (
                <option key={t} value={t}>
                  {t.replace(/_/g, ' ').toUpperCase()}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      <div className="contacts-list breach-review-list" style={{ marginTop: '16px' }}>
        {filteredAlerts.length === 0 ? (
          <div className="empty-state">
            <p>No breach records found matching the current filter.</p>
          </div>
        ) : (
          filteredAlerts.map((alert) => {
            const isActing = activeActionAlertId === alert.id;

            return (
              <div key={alert.id} className="contact-card breach-review-card">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '10px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <div className="plate-banner" style={{ fontSize: '18px', padding: '4px 12px' }}>
                      {alert.plate_number}
                    </div>
                    <div>
                      <div style={{ fontSize: '15px', fontWeight: 700, color: 'var(--color-danger)' }}>
                        {alert.breach_type.replace(/_/g, ' ').toUpperCase()}
                        {alert.zone_name ? ` · ${alert.zone_name}` : ''}
                      </div>
                      <div style={{ fontSize: '12px', color: 'var(--color-text-secondary)', marginTop: '2px' }}>
                        Logged: {new Date(alert.created_at).toLocaleString()}
                        {alert.observation_date ? ` · Observed: ${new Date(alert.observation_date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}
                      </div>
                    </div>
                  </div>

                  <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                    {alert.is_scv === false && (
                      <span className="badge badge-warning">NO SCV</span>
                    )}
                    {alert.is_scv === true && (
                      <span className="badge badge-info">SCV CERTIFIED</span>
                    )}
                    <span className={`badge ${alert.status === 'open' ? 'badge-danger' : alert.status === 'acknowledged' || alert.status === 'actioned' ? 'badge-warning' : alert.status === 'resolved' || alert.status === 'dismissed' ? 'badge-success' : 'badge-info'}`}>
                      {alert.status === 'exempt_homeless' ? 'EXEMPT - HOMELESS' : alert.status.toUpperCase()}
                    </span>
                  </div>
                </div>

                <div className="contact-details" style={{ marginTop: '10px' }}>
                  {alert.nights_count != null && (
                    <p style={{ margin: '0 0 4px 0', fontWeight: 600 }}>
                      ⚠️ {alert.nights_count} nights recorded {alert.limit_value ? `(Zone limit: ${alert.limit_value})` : ''}
                    </p>
                  )}
                  {alert.notes && <p style={{ margin: '0 0 4px 0', fontSize: '13px' }}>{alert.notes}</p>}
                  {alert.action_type && (
                    <p style={{ margin: '4px 0 0 0', fontSize: '12px', color: 'var(--color-success)' }}>
                      ✓ Actioned: {alert.action_type.replace(/_/g, ' ').toUpperCase()}
                      {alert.actioned_at ? ` on ${new Date(alert.actioned_at).toLocaleDateString()}` : ''}
                    </p>
                  )}
                  {alert.status === 'acknowledged' && alert.requested_action && (
                    <div className="alert alert-warning" role="status">
                      <strong>Officer request awaiting review</strong>
                      <p>{alert.requested_action.replaceAll('_', ' ')} · {(alert.enforcement_mode ?? 'policy').replaceAll('_', ' ')}</p>
                      {alert.request_notes && <p>{alert.request_notes}</p>}
                      {alert.requested_at && <small>Requested {new Date(alert.requested_at).toLocaleString('en-NZ')}</small>}
                    </div>
                  )}
                </div>

                {/* Enforcement Action Trigger Buttons */}
                {alert.status === 'open' && (
                  <div style={{ marginTop: '12px', borderTop: '1px solid var(--color-border)', paddingTop: '10px' }}>
                    {!isActing ? (
                      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                        <button
                          className="btn btn-sm btn-primary"
                          onClick={() => {
                            setActiveActionAlertId(alert.id);
                            setActionNotes('');
                          }}
                        >
                          ⚡ Select Enforcement Action
                        </button>
                        <button
                          className="btn btn-sm btn-danger"
                          disabled={busyId === alert.id}
                          onClick={() => { setActiveActionAlertId(alert.id);setActionNotes(''); }}
                        >
                          ✕ Dismiss Breach
                        </button>
                      </div>
                    ) : (
                      <div className="breach-action-editor" style={{ background: 'var(--color-bg-primary)', padding: '12px', borderRadius: '6px', border: '1px solid var(--color-border)' }}>
                        <div style={{ fontSize: '12px', fontWeight: 600, marginBottom: '8px' }}>
                          Select Enforcement Order or Warning to Issue:
                        </div>

                        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '10px' }}>
                          {ACTION_OPTIONS.map((act) => (
                            <button
                              key={act.type}
                              className={`btn btn-sm ${act.btnClass}`}
                              disabled={busyId === alert.id || !actionNotes.trim()}
                              onClick={() => handleAction(alert, act.type)}
                            >
                              {busyId === alert.id ? 'Processing…' : act.label}
                            </button>
                          ))}
                        </div>

                        <div className="form-group">
                          <label style={{ fontSize: '11px' }}>Enforcement / Review Note (Required)</label>
                          <input
                            type="text"
                            placeholder="e.g. Spoke to vehicle occupant; requested relocation by 10am"
                            value={actionNotes}
                            onChange={(e) => setActionNotes(e.target.value)}
                          />
                        </div>

                        <div style={{ marginTop: '8px' }}>
                          <button
                            className="btn btn-sm btn-secondary"
                            onClick={() => {
                              setActiveActionAlertId(null);
                              setActionNotes('');
                            }}
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {alert.status === 'acknowledged' && alert.requested_action && (
                  <div style={{ marginTop: '12px', borderTop: '1px solid var(--color-border)', paddingTop: '10px' }}>
                    <div className="form-group">
                      <label>Administrator review note</label>
                      <input
                        value={activeActionAlertId === alert.id ? actionNotes : ''}
                        onFocus={() => setActiveActionAlertId(alert.id)}
                        onChange={(event) => {
                          setActiveActionAlertId(alert.id);
                          setActionNotes(event.target.value);
                        }}
                        placeholder="Record why the request is approved or declined"
                      />
                    </div>
                    <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '8px' }}>
                      <button
                        className="btn btn-sm btn-primary"
                        onClick={() => void handleAction(alert, 'approve_requested')}
                        disabled={busyId === alert.id || activeActionAlertId !== alert.id || !actionNotes.trim()}
                      >
                        {busyId === alert.id ? 'Processing…' : `Approve ${alert.requested_action.replaceAll('_', ' ')}`}
                      </button>
                      <button
                        className="btn btn-sm btn-danger"
                        onClick={() => void handleAction(alert, 'dismissed')}
                        disabled={busyId === alert.id || activeActionAlertId !== alert.id || !actionNotes.trim()}
                      >
                        Decline request
                      </button>
                    </div>
                  </div>
                )}

                {/* Actioned alerts: mark as resolved or exempt_homeless */}
                {alert.status === 'actioned' && (
                  <div style={{ marginTop: '12px', borderTop: '1px solid var(--color-border)', paddingTop: '10px' }}>
                    <div className="form-group"><label>Resolution note</label><input value={activeActionAlertId===alert.id?actionNotes:''} onFocus={()=>setActiveActionAlertId(alert.id)} onChange={(event)=>{setActiveActionAlertId(alert.id);setActionNotes(event.target.value);}} /></div><div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap',marginTop:'8px' }}>
                      <button
                        className="btn btn-sm btn-success"
                        onClick={() => void handleAction(alert,'resolved')}
                        disabled={busyId===alert.id||activeActionAlertId!==alert.id||!actionNotes.trim()}
                      >
                        ✓ Mark Resolved
                      </button>
                      <button
                        className="btn btn-sm btn-secondary"
                        onClick={() => void handleAction(alert,'exempt_homeless')}
                        disabled={busyId===alert.id||activeActionAlertId!==alert.id||!actionNotes.trim()}
                      >
                        🏠 Mark Exempt - Homeless
                      </button>
                      {(['written_warning', 'notice_to_vacate', 'infringement'] as string[]).includes(alert.action_type ?? '') && <button className="btn btn-sm btn-primary" onClick={() => void generateNoticeDraft(alert)} disabled={generatingNoticeId === alert.id}>
                        {generatingNoticeId === alert.id ? 'Generating preview...' : 'Preview notice'}
                      </button>}
                      <button className="btn btn-sm btn-primary" onClick={() => void draftBobDocument(alert)} title="Draft a formal notice letter or incident report with Bob">
                        ✨ Bob: Draft document
                      </button>
                    </div>
                    {noticePreviews[alert.id] && !noticeReceipts[alert.id] && (
                      <div className="breach-action-editor">
                        <p><strong>Preview opened.</strong> Confirm it is correct, then type your full profile name to authorize formal issue and printing.</p>
                        <div className="form-group">
                          <label>Full name</label>
                          <input
                            value={typedAuthorizerNames[alert.id] ?? ''}
                            onChange={(event) => setTypedAuthorizerNames((current) => ({ ...current, [alert.id]: event.target.value }))}
                            autoComplete="name"
                          />
                        </div>
                        <button
                          className="btn btn-sm btn-primary"
                          onClick={() => void authorizeNoticePrint(alert)}
                          disabled={generatingNoticeId === alert.id || typedAuthorizerNames[alert.id] !== profile?.displayName}
                        >
                          {generatingNoticeId === alert.id ? 'Authorizing…' : 'Authorize Print'}
                        </button>
                      </div>
                    )}
                    {noticeReceipts[alert.id] && <NoticePrintActions receipt={noticeReceipts[alert.id]} organizationId={operatingOrganizationId ?? profile?.organizationId ?? null} />}
                    {noticeArtifactPaths[alert.id] && <GeneratedArtifactActions bucket="notice-artifacts" path={noticeArtifactPaths[alert.id]} fileName={`notice-${noticeReceipts[alert.id]?.noticeNumber ?? alert.id}.pdf`} label="Notice PDF" />}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};

export default BreachReviewPage;
