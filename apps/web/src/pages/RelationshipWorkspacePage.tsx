/**
 * RelationshipWorkspacePage.tsx
 *
 * Relationship-first workspace for the real operating model:
 * - organisations are not the main anchor
 * - service agreements bind provider/client relationships
 * - sites and zones are the durable operational anchor
 * - modules are granted per agreement and linked location context
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import { CrmAccountWorkspace, type CrmWorkspaceAccount } from '../components/CrmAccountWorkspace';

interface AgreementLocationLink {
  service_agreement_id: string;
  site_id: string | null;
  zone_id: string | null;
}

interface RelationshipRecord {
  id: string;
  name: string;
  agreement_type: string;
  invitation_status: string;
  provider_organization_id: string;
  client_organization_id: string;
  client_portal_access_mode: string | null;
  enabled_modules: string[];
  created_at: string;
  provider_name: string;
  client_name: string;
  site_count: number;
  zone_count: number;
  counterpart_id: string;
}

const RelationshipWorkspacePage: React.FC = () => {
  const { profile } = useAuth();
  const [relationships, setRelationships] = useState<RelationshipRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [workspaceAccount, setWorkspaceAccount] = useState<CrmWorkspaceAccount | null>(null);

  const loadRelationships = useCallback(async () => {
    if (!profile?.organizationId) return;

    try {
      setLoading(true);
      setError(null);

      const { data: agreements, error: agreementsErr } = await supabase
        .from('service_agreements')
        .select(
          'id, name, agreement_type, invitation_status, provider_organization_id, client_organization_id, client_portal_access_mode, enabled_modules, created_at, provider:provider_organization_id(id, name), client:client_organization_id(id, name)'
        )
        .or(`provider_organization_id.eq.${profile.organizationId},client_organization_id.eq.${profile.organizationId}`)
        .order('created_at', { ascending: false });

      if (agreementsErr) throw agreementsErr;

      const agreementIds = (agreements ?? []).map((agreement) => agreement.id);

      let locationLinks: AgreementLocationLink[] = [];
      if (agreementIds.length > 0) {
        const { data: links, error: linksErr } = await supabase
          .from('service_agreement_locations')
          .select('service_agreement_id, site_id, zone_id')
          .in('service_agreement_id', agreementIds);

        if (linksErr) throw linksErr;
        locationLinks = (links ?? []) as AgreementLocationLink[];
      }

      const groupedCounts = new Map<string, { siteCount: number; zoneCount: number }>();

      for (const link of locationLinks) {
        const current = groupedCounts.get(link.service_agreement_id) ?? { siteCount: 0, zoneCount: 0 };
        if (link.site_id) current.siteCount += 1;
        if (link.zone_id) current.zoneCount += 1;
        groupedCounts.set(link.service_agreement_id, current);
      }

      const mapped = (agreements ?? []).map((agreement: any) => {
        const provider = agreement.provider?.name ?? 'Unknown provider';
        const client = agreement.client?.name ?? 'Unknown client';
        const isProvider = agreement.provider_organization_id === profile.organizationId;
        const counterpartName = isProvider ? client : provider;
        const counterpartId = isProvider ? agreement.client_organization_id : agreement.provider_organization_id;
        const counts = groupedCounts.get(agreement.id) ?? { siteCount: 0, zoneCount: 0 };

        return {
          id: agreement.id,
          name: agreement.name,
          agreement_type: agreement.agreement_type,
          invitation_status: agreement.invitation_status,
          provider_organization_id: agreement.provider_organization_id,
          client_organization_id: agreement.client_organization_id,
          client_portal_access_mode: agreement.client_portal_access_mode,
          enabled_modules: Array.isArray(agreement.enabled_modules) ? agreement.enabled_modules : [],
          created_at: agreement.created_at,
          provider_name: provider,
          client_name: client,
          site_count: counts.siteCount,
          zone_count: counts.zoneCount,
          counterpart_name: counterpartName,
          counterpart_id: counterpartId,
        };
      });

      const sorted = mapped.sort((a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      );

      setRelationships(sorted as RelationshipRecord[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load relationship workspace');
    } finally {
      setLoading(false);
    }
  }, [profile?.organizationId]);

  useEffect(() => {
    loadRelationships();
  }, [loadRelationships]);

  const summary = useMemo(() => {
    return {
      totalAgreements: relationships.length,
      totalSites: relationships.reduce((sum, relationship) => sum + relationship.site_count, 0),
      totalZones: relationships.reduce((sum, relationship) => sum + relationship.zone_count, 0),
      activeAgreements: relationships.filter((relationship) => relationship.invitation_status === 'accepted').length,
    };
  }, [relationships]);

  if (loading) {
    return (
      <div className="page-container">
        <div className="loading-state">
          <div className="spinner" />
          <p>Loading service relationships...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page-container">
      <header className="page-header">
        <div>
          <h1>Relationship Workspace</h1>
          <p className="subtitle">
            Service agreements are the access layer. Sites and zones are the durable operational anchor.
          </p>
        </div>
      </header>

      {error && (
        <div className="alert alert-error" role="alert">
          <button className="alert-close" onClick={() => setError(null)} aria-label="Close alert">
            ×
          </button>
          {error}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 16, marginBottom: 24 }}>
        <SummaryCard label="Agreements" value={String(summary.totalAgreements)} />
        <SummaryCard label="Sites linked" value={String(summary.totalSites)} />
        <SummaryCard label="Zones linked" value={String(summary.totalZones)} />
        <SummaryCard label="Accepted" value={String(summary.activeAgreements)} />
      </div>

      {relationships.length === 0 ? (
        <div className="empty-state">
          <p>No active service relationships are linked to this organisation yet.</p>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 16 }}>
          {relationships.map((relationship) => {
            const isProvider = relationship.provider_organization_id === profile?.organizationId;
            const counterpartName = isProvider ? relationship.client_name : relationship.provider_name;
            const counterpartRole = isProvider ? 'Client org' : 'Provider org';

            return (
              <div
                key={relationship.id}
                style={{
                  background: 'var(--color-bg-surface)',
                  border: '1px solid var(--color-border)',
                  borderRadius: 12,
                  padding: 20,
                  boxShadow: '0 8px 20px rgba(0,0,0,0.04)',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                  <div>
                    <div style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--color-text-secondary)' }}>
                      {relationship.agreement_type} agreement
                    </div>
                    <h2 style={{ margin: '8px 0', fontSize: 26 }}>{relationship.name}</h2>
                    <div style={{ color: 'var(--color-text-secondary)' }}>
                      {counterpartRole}: <strong>{counterpartName}</strong>
                    </div>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span
                      style={{
                        background: relationship.invitation_status === 'accepted' ? 'rgba(31, 120, 90, 0.12)' : 'rgba(174, 104, 0, 0.12)',
                        border: '1px solid var(--color-border)',
                        borderRadius: 999,
                        padding: '6px 10px',
                        fontSize: 12,
                        color: 'var(--color-text-primary)',
                        textTransform: 'capitalize',
                      }}
                    >
                      {relationship.invitation_status}
                    </span>
                    <span
                      style={{
                        background: 'rgba(77, 123, 255, 0.08)',
                        border: '1px solid rgba(77, 123, 255, 0.2)',
                        borderRadius: 999,
                        padding: '6px 10px',
                        fontSize: 12,
                        color: 'var(--color-text-primary)',
                      }}
                    >
                      {relationship.client_portal_access_mode ?? 'transparency_only'}
                    </span>
                  </div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginTop: 18 }}>
                  <MetricPill label="Sites linked" value={String(relationship.site_count)} />
                  <MetricPill label="Zones linked" value={String(relationship.zone_count)} />
                  <MetricPill label="Provider" value={relationship.provider_name} />
                  <MetricPill label="Client" value={relationship.client_name} />
                </div>

                <div style={{ marginTop: 18 }}>
                  <div style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--color-text-secondary)', marginBottom: 8 }}>
                    Enabled modules
                  </div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {relationship.enabled_modules.length === 0 ? (
                      <span style={{ color: 'var(--color-text-secondary)' }}>No module grant configured for this agreement.</span>
                    ) : (
                      relationship.enabled_modules.map((moduleKey) => (
                        <span
                          key={`${relationship.id}-${moduleKey}`}
                          style={{
                            background: 'rgba(160, 120, 255, 0.08)',
                            border: '1px solid rgba(160, 120, 255, 0.2)',
                            borderRadius: 999,
                            padding: '6px 10px',
                            fontSize: 12,
                            color: 'var(--color-text-primary)',
                          }}
                        >
                          {moduleKey}
                        </span>
                      ))
                    )}
                  </div>
                </div>
                {isProvider && <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--color-border)' }}><button type="button" className="btn btn-primary" onClick={() => setWorkspaceAccount({ id: relationship.counterpart_id, name: counterpartName, agreementId: relationship.id })}>Manage relationship</button></div>}
              </div>
            );
          })}
        </div>
      )}
      {workspaceAccount && <CrmAccountWorkspace account={workspaceAccount} onClose={() => setWorkspaceAccount(null)} />}
    </div>
  );
};

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        background: 'var(--color-bg-surface)',
        borderRadius: 12,
        border: '1px solid var(--color-border)',
        padding: '16px 18px',
      }}
    >
      <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
        {label}
      </div>
      <div style={{ marginTop: 6, fontSize: 28, fontWeight: 700, color: 'var(--color-text-primary)' }}>{value}</div>
    </div>
  );
}

function MetricPill({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        background: 'var(--color-bg-primary)',
        border: '1px solid var(--color-border)',
        borderRadius: 10,
        padding: '12px 14px',
      }}
    >
      <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        {label}
      </div>
      <div style={{ marginTop: 6, fontSize: 14, color: 'var(--color-text-primary)', fontWeight: 600 }}>{value}</div>
    </div>
  );
}

export default RelationshipWorkspacePage;
