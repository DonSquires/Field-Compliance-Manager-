import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useAuth } from './AuthContext';
import { supabase } from '../lib/supabase';

export interface ServiceAgreementContextRow {
  id: string;
  name: string;
  agreement_type: string;
  invitation_status: string;
  provider_organization_id: string;
  client_organization_id: string;
  client_portal_access_mode: string | null;
  enabled_modules: string[];
  created_at: string;
  provider_name: string | null;
  client_name: string | null;
}

export interface ServiceLocationSite {
  id: string;
  name: string;
  address: string | null;
  site_type: string | null;
  client_organization_id: string | null;
  service_agreement_id: string | null;
  active: boolean;
}

export interface ServiceLocationZone {
  id: string;
  name: string;
  zone_type: string | null;
  location_id: string | null;
  organization_id: string | null;
  is_active: boolean;
  service_agreement_id: string | null;
}

interface ServiceAgreementLocationLink {
  service_agreement_id: string;
  site_id: string | null;
  zone_id: string | null;
}

interface ServiceRelationshipContextValue {
  agreements: ServiceAgreementContextRow[];
  sites: ServiceLocationSite[];
  zones: ServiceLocationZone[];
  selectedAgreementId: string | null;
  selectedSiteId: string | null;
  selectedZoneId: string | null;
  selectedAgreement: ServiceAgreementContextRow | null;
  selectedSite: ServiceLocationSite | null;
  selectedZone: ServiceLocationZone | null;
  selectedAgreementSites: ServiceLocationSite[];
  selectedAgreementZones: ServiceLocationZone[];
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
  selectAgreement: (agreementId: string | null) => void;
  selectSite: (siteId: string | null) => void;
  selectZone: (zoneId: string | null) => void;
}

const ServiceRelationshipContext = createContext<ServiceRelationshipContextValue>({
  agreements: [],
  sites: [],
  zones: [],
  selectedAgreementId: null,
  selectedSiteId: null,
  selectedZoneId: null,
  selectedAgreement: null,
  selectedSite: null,
  selectedZone: null,
  selectedAgreementSites: [],
  selectedAgreementZones: [],
  loading: true,
  error: null,
  refetch: async () => undefined,
  selectAgreement: () => undefined,
  selectSite: () => undefined,
  selectZone: () => undefined,
});

export function ServiceRelationshipProvider({ children }: { children: ReactNode }) {
  const { profile } = useAuth();
  const [agreements, setAgreements] = useState<ServiceAgreementContextRow[]>([]);
  const [sites, setSites] = useState<ServiceLocationSite[]>([]);
  const [zones, setZones] = useState<ServiceLocationZone[]>([]);
  const [agreementLocationLinks, setAgreementLocationLinks] = useState<ServiceAgreementLocationLink[]>([]);
  const [selectedAgreementId, setSelectedAgreementId] = useState<string | null>(null);
  const [selectedSiteId, setSelectedSiteId] = useState<string | null>(null);
  const [selectedZoneId, setSelectedZoneId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    if (!profile?.organizationId) {
      setAgreements([]);
      setSites([]);
      setZones([]);
      setAgreementLocationLinks([]);
      setSelectedAgreementId(null);
      setSelectedSiteId(null);
      setSelectedZoneId(null);
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      setError(null);

      const { data: agreementRows, error: agreementsError } = await supabase
        .from('service_agreements')
        .select(
          'id, name, agreement_type, invitation_status, provider_organization_id, client_organization_id, client_portal_access_mode, enabled_modules, created_at, provider:provider_organization_id(id, name), client:client_organization_id(id, name)'
        )
        .or(`provider_organization_id.eq.${profile.organizationId},client_organization_id.eq.${profile.organizationId}`)
        .order('created_at', { ascending: false });

      if (agreementsError) throw agreementsError;

      const normalizedAgreements = (agreementRows ?? []).map((agreement: any) => ({
        id: agreement.id,
        name: agreement.name,
        agreement_type: agreement.agreement_type,
        invitation_status: agreement.invitation_status,
        provider_organization_id: agreement.provider_organization_id,
        client_organization_id: agreement.client_organization_id,
        client_portal_access_mode: agreement.client_portal_access_mode,
        enabled_modules: Array.isArray(agreement.enabled_modules) ? agreement.enabled_modules : [],
        created_at: agreement.created_at,
        provider_name: agreement.provider?.name ?? null,
        client_name: agreement.client?.name ?? null,
      }));

      setAgreements(normalizedAgreements);

      const agreementIds = normalizedAgreements.map((agreement) => agreement.id);
      let linkedSites: ServiceLocationSite[] = [];
      let linkedZones: ServiceLocationZone[] = [];

      if (agreementIds.length > 0) {
        const { data: links, error: linksError } = await supabase
          .from('service_agreement_locations')
          .select('service_agreement_id, site_id, zone_id')
          .in('service_agreement_id', agreementIds);

        if (linksError) throw linksError;

        setAgreementLocationLinks((links ?? []) as ServiceAgreementLocationLink[]);

        const siteIds = (links ?? []).map((link) => link.site_id).filter(Boolean) as string[];
        const zoneIds = (links ?? []).map((link) => link.zone_id).filter(Boolean) as string[];

        if (siteIds.length > 0) {
          const { data: siteData, error: siteError } = await supabase
            .from('client_sites')
            .select('id, name, address, site_type, client_organization_id, service_agreement_id, active')
            .in('id', siteIds);

          if (siteError) throw siteError;
          linkedSites = (siteData ?? []).map((site: any) => ({
            id: site.id,
            name: site.name,
            address: site.address ?? null,
            site_type: site.site_type ?? null,
            client_organization_id: site.client_organization_id ?? null,
            service_agreement_id: site.service_agreement_id ?? null,
            active: Boolean(site.active),
          }));
        }

        if (zoneIds.length > 0) {
          const { data: zoneData, error: zoneError } = await supabase
            .from('location_zones')
            .select('id, name, zone_type, location_id, organization_id, is_active, service_agreement_id')
            .in('id', zoneIds);

          if (zoneError) throw zoneError;
          linkedZones = (zoneData ?? []).map((zone: any) => ({
            id: zone.id,
            name: zone.name,
            zone_type: zone.zone_type ?? null,
            location_id: zone.location_id ?? null,
            organization_id: zone.organization_id ?? null,
            is_active: Boolean(zone.is_active),
            service_agreement_id: zone.service_agreement_id ?? null,
          }));
        }
      }

      setSites(linkedSites);
      setZones(linkedZones);
      if (agreementIds.length === 0) setAgreementLocationLinks([]);

      setSelectedAgreementId((current) => {
        if (current && normalizedAgreements.some((agreement) => agreement.id === current)) return current;
        return normalizedAgreements[0]?.id ?? null;
      });

      if (selectedAgreementId && normalizedAgreements.some((agreement) => agreement.id === selectedAgreementId)) {
        setSelectedSiteId((current) => {
          const currentSiteExists = linkedSites.some((site) => site.id === current);
          if (!currentSiteExists) {
            return linkedSites[0]?.id ?? null;
          }
          return current;
        });
        setSelectedZoneId((current) => {
          const currentZoneExists = linkedZones.some((zone) => zone.id === current);
          if (!currentZoneExists) {
            return linkedZones[0]?.id ?? null;
          }
          return current;
        });
      } else {
        setSelectedSiteId(linkedSites[0]?.id ?? null);
        setSelectedZoneId(linkedZones[0]?.id ?? null);
      }
    } catch (err) {
      console.error('Failed to load service relationship context:', err);
      setError(err instanceof Error ? err.message : 'Failed to load service relationship context');
      setAgreements([]);
      setSites([]);
      setZones([]);
      setAgreementLocationLinks([]);
      setSelectedAgreementId(null);
      setSelectedSiteId(null);
      setSelectedZoneId(null);
    } finally {
      setLoading(false);
    }
  }, [profile?.organizationId, selectedAgreementId]);

  useEffect(() => {
    void refetch();
  }, [profile?.organizationId]);

  const selectedAgreement = useMemo(
    () => agreements.find((agreement) => agreement.id === selectedAgreementId) ?? null,
    [agreements, selectedAgreementId]
  );

  const selectedSite = useMemo(
    () => sites.find((site) => site.id === selectedSiteId) ?? null,
    [sites, selectedSiteId]
  );

  const selectedZone = useMemo(
    () => zones.find((zone) => zone.id === selectedZoneId) ?? null,
    [zones, selectedZoneId]
  );

  const selectedAgreementLinks = useMemo(
    () => agreementLocationLinks.filter((link) => link.service_agreement_id === selectedAgreementId),
    [agreementLocationLinks, selectedAgreementId]
  );

  const selectedAgreementSiteIds = useMemo(
    () => new Set(selectedAgreementLinks.map((link) => link.site_id).filter(Boolean)),
    [selectedAgreementLinks]
  );

  const selectedAgreementZoneIds = useMemo(
    () => new Set(selectedAgreementLinks.map((link) => link.zone_id).filter(Boolean)),
    [selectedAgreementLinks]
  );

  const selectedAgreementSites = useMemo(
    () => sites.filter((site) => selectedAgreementSiteIds.has(site.id)),
    [sites, selectedAgreementSiteIds]
  );

  const selectedAgreementZones = useMemo(
    () => zones.filter((zone) => selectedAgreementZoneIds.has(zone.id)),
    [zones, selectedAgreementZoneIds]
  );

  const value = useMemo<ServiceRelationshipContextValue>(() => ({
    agreements,
    sites,
    zones,
    selectedAgreementId,
    selectedSiteId,
    selectedZoneId,
    selectedAgreement,
    selectedSite,
    selectedZone,
    selectedAgreementSites,
    selectedAgreementZones,
    loading,
    error,
    refetch,
    selectAgreement: (agreementId) => {
      setSelectedAgreementId(agreementId);
      const links = agreementLocationLinks.filter((link) => link.service_agreement_id === agreementId);
      const siteIds = new Set(links.map((link) => link.site_id).filter(Boolean));
      const zoneIds = new Set(links.map((link) => link.zone_id).filter(Boolean));
      setSelectedSiteId(sites.find((site) => siteIds.has(site.id))?.id ?? null);
      setSelectedZoneId(zones.find((zone) => zoneIds.has(zone.id))?.id ?? null);
    },
    selectSite: (siteId) => {
      setSelectedSiteId(siteId);
      if (siteId) setSelectedZoneId(null);
    },
    selectZone: (zoneId) => {
      setSelectedZoneId(zoneId);
      if (zoneId) setSelectedSiteId(null);
    },
  }), [agreements, sites, zones, agreementLocationLinks, selectedAgreementId, selectedSiteId, selectedZoneId, selectedAgreement, selectedSite, selectedZone, selectedAgreementSites, selectedAgreementZones, loading, error, refetch]);

  return <ServiceRelationshipContext.Provider value={value}>{children}</ServiceRelationshipContext.Provider>;
}

export function useServiceRelationships() {
  return useContext(ServiceRelationshipContext);
}
