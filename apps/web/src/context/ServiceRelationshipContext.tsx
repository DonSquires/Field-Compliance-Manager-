import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useAuth } from './AuthContext';
import { resolveAddressForCoordinates } from '../lib/locationAddress';
import { supabase } from '../lib/supabase';

export interface ServiceAgreementContextRow {
  id: string;
  name: string;
  agreement_type: string;
  invitation_status: string;
  provider_organization_id: string;
  client_organization_id: string;
  client_portal_access_mode: string | null;
  client_portal_reports_enabled: boolean;
  client_portal_finance_enabled: boolean;
  allows_client_submission: boolean;
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
  locationStatus: 'idle' | 'locating' | 'resolved' | 'outside_geofence' | 'unavailable';
  currentCoordinates: { lat: number; lng: number } | null;
  currentAddress: string | null;
  geofenceResolution: { resolutionStatus: string; siteId: string | null; zoneId: string | null } | null;
  locationError: string | null;
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
  locationStatus: 'idle',
  currentCoordinates: null,
  currentAddress: null,
  geofenceResolution: null,
  locationError: null,
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
  const [locationStatus, setLocationStatus] = useState<ServiceRelationshipContextValue['locationStatus']>('idle');
  const [currentCoordinates, setCurrentCoordinates] = useState<{ lat: number; lng: number } | null>(null);
  const [currentAddress, setCurrentAddress] = useState<string | null>(null);
  const [geofenceResolution, setGeofenceResolution] = useState<ServiceRelationshipContextValue['geofenceResolution']>(null);
  const [locationError, setLocationError] = useState<string | null>(null);
  const locationRequestRef = useRef(0);

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

      // Agreements are held at branch level (Model A): an employer-organisation user also works within its branches' agreements.
      // Client-side users only ever see agreements where they are the client.
      const isClientUser = profile.role.startsWith('client_');
      let providerOrgIds = [profile.organizationId];
      if (!isClientUser) {
        const { data: descendants } = await supabase.rpc('get_descendant_organizations', { org_id: profile.organizationId });
        if (Array.isArray(descendants) && descendants.length) providerOrgIds = [...new Set([profile.organizationId, ...descendants])];
      }

      const { data: agreementRows, error: agreementsError } = await supabase
        .from('service_agreements')
        .select(
          'id, name, agreement_type, invitation_status, provider_organization_id, client_organization_id, client_portal_access_mode, client_portal_reports_enabled, client_portal_finance_enabled, allows_client_submission, enabled_modules, created_at, provider:provider_organization_id(id, name), client:client_organization_id(id, name)'
        )
        .or(isClientUser ? `client_organization_id.eq.${profile.organizationId}` : `provider_organization_id.in.(${providerOrgIds.join(',')}),client_organization_id.eq.${profile.organizationId}`)
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
        client_portal_reports_enabled: Boolean(agreement.client_portal_reports_enabled),
        client_portal_finance_enabled: Boolean(agreement.client_portal_finance_enabled),
        allows_client_submission: Boolean(agreement.allows_client_submission),
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
          .in('service_agreement_id', agreementIds)
          .eq('status', 'active');

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
            .select('id, name, zone_type, location_id, organization_id, is_active')
            .in('id', zoneIds);

          if (zoneError) throw zoneError;
          linkedZones = (zoneData ?? []).map((zone: any) => ({
            id: zone.id,
            name: zone.name,
            zone_type: zone.zone_type ?? null,
            location_id: zone.location_id ?? null,
            organization_id: zone.organization_id ?? null,
            is_active: Boolean(zone.is_active),
            service_agreement_id: (links ?? []).find((link) => link.zone_id === zone.id)?.service_agreement_id ?? null,
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
  }, [profile?.organizationId, profile?.role, selectedAgreementId]);

  useEffect(() => {
    void refetch();
  }, [profile?.organizationId, profile?.role]);

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

  useEffect(() => {
    const organizationId = profile?.organizationId;
    // Client portal users read delivered records; their position is never asked for or recorded.
    if (!organizationId || profile?.role.startsWith('client_')) {
      setLocationStatus('idle');
      setCurrentCoordinates(null);
      setCurrentAddress(null);
      setGeofenceResolution(null);
      setLocationError(null);
      return undefined;
    }
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setLocationStatus('unavailable');
      setLocationError('This device does not provide location services.');
      return undefined;
    }

    setLocationStatus('locating');
    const watchId = navigator.geolocation.watchPosition(async (position) => {
      const requestId = locationRequestRef.current + 1;
      locationRequestRef.current = requestId;
      const coordinates = { lat: position.coords.latitude, lng: position.coords.longitude };
      setCurrentCoordinates(coordinates);
      setLocationStatus('locating');
      setLocationError(null);

      try {
        const [{ data, error: resolutionError }, address] = await Promise.all([
          supabase.rpc('resolve_context_authorized', {
            p_lat: coordinates.lat,
            p_lng: coordinates.lng,
            p_org_id: organizationId,
            p_module_key: null,
          }),
          resolveAddressForCoordinates(coordinates.lat, coordinates.lng),
        ]);
        if (requestId !== locationRequestRef.current) return;
        setCurrentAddress(address?.label ?? null);
        if (resolutionError) throw resolutionError;
        const row = Array.isArray(data) ? data[0] : data;
        const zoneId = row?.matched_zone_id ?? null;
        const siteId = row?.site_id ?? null;
        const matchedAgreementZone = zoneId && selectedAgreementZones.some((zone) => zone.id === zoneId);
        const matchedAgreementSite = siteId && selectedAgreementSites.some((site) => site.id === siteId);
        // P1: an absent resolver row is 'unavailable', never a fabricated "outside all geofences".
        setGeofenceResolution({ resolutionStatus: row?.resolution_status ?? 'unavailable', siteId, zoneId });
        if (matchedAgreementZone) {
          setSelectedZoneId(zoneId);
          setSelectedSiteId(null);
          setLocationStatus('resolved');
        } else if (matchedAgreementSite) {
          setSelectedSiteId(siteId);
          setSelectedZoneId(null);
          setLocationStatus('resolved');
        } else {
          setSelectedSiteId(null);
          setSelectedZoneId(null);
          setLocationStatus('outside_geofence');
        }
      } catch (locationLoadError) {
        if (requestId !== locationRequestRef.current) return;
        setLocationStatus('unavailable');
        setLocationError(locationLoadError instanceof Error ? locationLoadError.message : 'Geofence location could not be resolved.');
      }
    }, (positionError) => {
      setLocationStatus('unavailable');
      setLocationError(positionError.message || 'Location permission was not granted.');
    }, { enableHighAccuracy: true, maximumAge: 30_000, timeout: 15_000 });

    return () => navigator.geolocation.clearWatch(watchId);
  }, [profile?.organizationId, selectedAgreementSites, selectedAgreementZones]);

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
    locationStatus,
    currentCoordinates,
    currentAddress,
    geofenceResolution,
    locationError,
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
  }), [agreements, sites, zones, agreementLocationLinks, selectedAgreementId, selectedSiteId, selectedZoneId, selectedAgreement, selectedSite, selectedZone, selectedAgreementSites, selectedAgreementZones, loading, error, locationStatus, currentCoordinates, currentAddress, geofenceResolution, locationError, refetch]);

  return <ServiceRelationshipContext.Provider value={value}>{children}</ServiceRelationshipContext.Provider>;
}

export function useServiceRelationships() {
  return useContext(ServiceRelationshipContext);
}
