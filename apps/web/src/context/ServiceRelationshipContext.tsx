import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useAuth } from './AuthContext';
import { agreementTermRank } from '../lib/agreementTerm';
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
  starts_on: string | null;
  ends_on: string | null;
  provider_name: string | null;
  client_name: string | null;
}

export interface ServiceLocationSite {
  id: string;
  name: string;
  address: string | null;
  location_id?: string | null;
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
  module_key?: string | null;
  service_agreement_id: string | null;
}

interface ServiceAgreementLocationLink {
  id: string;
  service_agreement_id: string;
  site_id: string | null;
  zone_id: string | null;
}

export interface ActiveShiftLocationContext {
  organizationId: string;
  moduleKey: string | null;
  locationId: string | null;
  serviceAgreementLocationId: string | null;
  siteIds: string[];
  zoneIds: string[];
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
  loadedOrganizationId: string | null;
  error: string | null;
  locationStatus: 'idle' | 'locating' | 'resolved' | 'outside_geofence' | 'unavailable';
  currentCoordinates: { lat: number; lng: number } | null;
  currentAddress: string | null;
  geofenceResolution: { resolutionStatus: string; siteId: string | null; zoneId: string | null } | null;
  locationError: string | null;
  locationMode: 'manual' | 'gps';
  refetch: () => Promise<void>;
  setLocationMode: (mode: 'manual' | 'gps') => void;
  selectAgreement: (agreementId: string | null) => void;
  selectAgreementLocation: (locationId: string | null) => void;
  setActiveShiftLocationContext: (context: ActiveShiftLocationContext | null) => void;
  selectSite: (siteId: string | null) => void;
  selectZone: (zoneId: string | null) => void;
}

const LOCATION_REFRESH_MS = 30_000;
const ADDRESS_REFRESH_MS = 30_000;
const GEOFENCE_RESOLUTION_TIMEOUT_MS = 15_000;

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
  loadedOrganizationId: null,
  error: null,
  locationStatus: 'idle',
  currentCoordinates: null,
  currentAddress: null,
  geofenceResolution: null,
  locationError: null,
  locationMode: 'manual',
  refetch: async () => undefined,
  setLocationMode: () => undefined,
  selectAgreement: () => undefined,
  selectAgreementLocation: () => undefined,
  setActiveShiftLocationContext: () => undefined,
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
  const [activeShiftLocationContext, setActiveShiftLocationContextState] = useState<ActiveShiftLocationContext | null>(null);
  const [selectedPlaceIds, setSelectedPlaceIds] = useState<{ siteId: string | null; zoneId: string | null }>({ siteId: null, zoneId: null });
  const selectedSiteId = selectedPlaceIds.siteId;
  const selectedZoneId = selectedPlaceIds.zoneId;
  const [loading, setLoading] = useState(true);
  const [loadedOrganizationId, setLoadedOrganizationId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [locationStatus, setLocationStatus] = useState<ServiceRelationshipContextValue['locationStatus']>('idle');
  const [currentCoordinates, setCurrentCoordinates] = useState<{ lat: number; lng: number } | null>(null);
  const [currentAddress, setCurrentAddress] = useState<string | null>(null);
  const [geofenceResolution, setGeofenceResolution] = useState<ServiceRelationshipContextValue['geofenceResolution']>(null);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [locationMode, setLocationMode] = useState<'manual' | 'gps'>('manual');
  const locationRequestRef = useRef(0);

  const refetch = useCallback(async () => {
    if (!profile?.organizationId) {
      setLoadedOrganizationId(null);
      setAgreements([]);
      setSites([]);
      setZones([]);
      setAgreementLocationLinks([]);
      setSelectedAgreementId(null);
      setSelectedPlaceIds({ siteId: null, zoneId: null });
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      setLoadedOrganizationId(null);
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
          'id, name, agreement_type, invitation_status, provider_organization_id, client_organization_id, client_portal_access_mode, client_portal_reports_enabled, client_portal_finance_enabled, allows_client_submission, enabled_modules, created_at, starts_on, ends_on, provider:provider_organization_id(id, name), client:client_organization_id(id, name)'
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
        starts_on: agreement.starts_on ?? null,
        ends_on: agreement.ends_on ?? null,
        provider_name: agreement.provider?.name ?? null,
        client_name: agreement.client?.name ?? null,
      }))
        // Live agreements first: an ended or cancelled one must never be the portal's or the console's default.
        .sort((left: ServiceAgreementContextRow, right: ServiceAgreementContextRow) => agreementTermRank(left) - agreementTermRank(right) || right.created_at.localeCompare(left.created_at));

      setAgreements(normalizedAgreements);

      const agreementIds = normalizedAgreements.map((agreement) => agreement.id);
      let linkedSites: ServiceLocationSite[] = [];
      let linkedZones: ServiceLocationZone[] = [];
      let loadedLinks: ServiceAgreementLocationLink[] = [];

      if (agreementIds.length > 0) {
        const { data: links, error: linksError } = await supabase
          .from('service_agreement_locations')
          .select('id, service_agreement_id, site_id, zone_id')
          .in('service_agreement_id', agreementIds)
          .eq('status', 'active');

        if (linksError) throw linksError;

        loadedLinks = (links ?? []) as ServiceAgreementLocationLink[];
        setAgreementLocationLinks(loadedLinks);

        const siteIds = (links ?? []).map((link) => link.site_id).filter(Boolean) as string[];
        const zoneIds = (links ?? []).map((link) => link.zone_id).filter(Boolean) as string[];

        if (siteIds.length > 0) {
          const { data: siteData, error: siteError } = await supabase
            .from('client_sites')
            .select('id, name, address, site_type, location_id, client_organization_id, service_agreement_id, active')
            .in('id', siteIds);

          if (siteError) throw siteError;
          linkedSites = (siteData ?? []).map((site: any) => ({
            id: site.id,
            name: site.name,
            address: site.address ?? null,
            site_type: site.site_type ?? null,
            location_id: site.location_id ?? null,
            client_organization_id: site.client_organization_id ?? null,
            service_agreement_id: site.service_agreement_id ?? null,
            active: Boolean(site.active),
          }));
        }

        if (zoneIds.length > 0) {
          const { data: zoneData, error: zoneError } = await supabase
            .from('location_zones')
            .select('id, name, zone_type, location_id, organization_id, is_active, module_key')
            .in('id', zoneIds);

          if (zoneError) throw zoneError;
          linkedZones = (zoneData ?? []).map((zone: any) => ({
            id: zone.id,
            name: zone.name,
            zone_type: zone.zone_type ?? null,
            location_id: zone.location_id ?? null,
            organization_id: zone.organization_id ?? null,
            is_active: Boolean(zone.is_active),
            module_key: zone.module_key ?? null,
            service_agreement_id: (links ?? []).find((link) => link.zone_id === zone.id)?.service_agreement_id ?? null,
          }));
        }
      }

      setSites(linkedSites);
      setZones(linkedZones);
      if (agreementIds.length === 0) setAgreementLocationLinks([]);

      const nextAgreementId = selectedAgreementId && normalizedAgreements.some((agreement) => agreement.id === selectedAgreementId)
        ? selectedAgreementId
        : normalizedAgreements[0]?.id ?? null;
      setSelectedAgreementId(nextAgreementId);
      const nextLinks = loadedLinks.filter((link) => link.service_agreement_id === nextAgreementId);
      const nextSiteIds = new Set(nextLinks.map((link) => link.site_id).filter(Boolean));
      const nextZoneIds = new Set(nextLinks.map((link) => link.zone_id).filter(Boolean));
      setSelectedPlaceIds((current) => {
        if (current.zoneId && nextZoneIds.has(current.zoneId) && linkedZones.some((zone) => zone.id === current.zoneId)) return { siteId: null, zoneId: current.zoneId };
        if (current.siteId && nextSiteIds.has(current.siteId) && linkedSites.some((site) => site.id === current.siteId)) return { siteId: current.siteId, zoneId: null };
        const zoneId = linkedZones.find((zone) => nextZoneIds.has(zone.id))?.id ?? null;
        if (zoneId) return { siteId: null, zoneId };
        return { siteId: linkedSites.find((site) => nextSiteIds.has(site.id))?.id ?? null, zoneId: null };
      });
      setLoadedOrganizationId(profile.organizationId);
    } catch (err) {
      console.error('Failed to load service relationship context:', err);
      setError(err instanceof Error ? err.message : 'Failed to load service relationship context');
      setAgreements([]);
      setSites([]);
      setZones([]);
      setAgreementLocationLinks([]);
      setSelectedAgreementId(null);
      setSelectedPlaceIds({ siteId: null, zoneId: null });
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
  const locationScopeRef = useRef({ agreementLocationLinks, selectedAgreementSites, selectedAgreementZones, sites, zones });
  locationScopeRef.current = { agreementLocationLinks, selectedAgreementSites, selectedAgreementZones, sites, zones };

  useEffect(() => {
    if (!activeShiftLocationContext) return;
    const link = activeShiftLocationContext.serviceAgreementLocationId
      ? agreementLocationLinks.find((item) => item.id === activeShiftLocationContext.serviceAgreementLocationId)
      : null;
    if (activeShiftLocationContext.serviceAgreementLocationId && !link) return;
    if (link) {
      setSelectedAgreementId((current) => current === link.service_agreement_id ? current : link.service_agreement_id);
      setSelectedPlaceIds((current) => current.siteId === link.site_id && current.zoneId === link.zone_id
        ? current
        : { siteId: link.site_id, zoneId: link.zone_id });
    } else if (activeShiftLocationContext.siteIds.length || activeShiftLocationContext.zoneIds.length) {
      const siteId = activeShiftLocationContext.siteIds[0] ?? null;
      const zoneId = activeShiftLocationContext.zoneIds[0] ?? null;
      setSelectedPlaceIds((current) => current.siteId === siteId && current.zoneId === zoneId
        ? current
        : { siteId, zoneId });
    }
  }, [activeShiftLocationContext, agreementLocationLinks]);

  const setActiveShiftLocationContext = useCallback((context: ActiveShiftLocationContext | null) => {
    setActiveShiftLocationContextState(context);
  }, []);

  useEffect(() => {
    const organizationId = activeShiftLocationContext?.organizationId ?? profile?.organizationId;
    const moduleKey = activeShiftLocationContext?.moduleKey ?? null;
    const serviceContextReady = !loading && loadedOrganizationId === profile?.organizationId;
    // Admin selection is deliberate. Only field/scan shells opt into GPS resolution.
    if (locationMode !== 'gps' || !organizationId || profile?.role.startsWith('client_')) {
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
    if (activeShiftLocationContext && !moduleKey) {
      setLocationStatus('unavailable');
      setLocationError('The active shift service module could not be confirmed.');
      return undefined;
    }

    let active = true;
    let hasResolution = false;
    let geofenceRequestInFlight = false;
    let addressRequestInFlight = false;
    let latestCoordinates: { lat: number; lng: number } | null = null;
    let addressRefreshTimer: number | null = null;
    let geofenceTimeoutId: number | null = null;

    const scheduleAddressRefresh = () => {
      if (!active || addressRefreshTimer !== null) return;
      addressRefreshTimer = window.setTimeout(() => {
        addressRefreshTimer = null;
        if (!active || !latestCoordinates || addressRequestInFlight) return;
        addressRequestInFlight = true;
        const coordinates = latestCoordinates;
        void resolveAddressForCoordinates(coordinates.lat, coordinates.lng)
          .then((address) => {
            if (active) setCurrentAddress(address?.label ?? null);
          })
          .catch(() => undefined)
          .finally(() => {
            addressRequestInFlight = false;
            scheduleAddressRefresh();
          });
      }, ADDRESS_REFRESH_MS);
    };

    const resolveGeofence = async (coordinates: { lat: number; lng: number }, requestId: number) => {
      try {
        const resolution = supabase.rpc('resolve_operational_context_authorized', {
          p_lat: coordinates.lat,
          p_lng: coordinates.lng,
          p_org_id: organizationId,
          p_module_key: moduleKey,
        });
        const response = await Promise.race([
          resolution,
          new Promise<never>((_, reject) => {
            geofenceTimeoutId = window.setTimeout(() => reject(new Error('Geofence lookup timed out.')), GEOFENCE_RESOLUTION_TIMEOUT_MS);
          }),
        ]);
        const { data, error: resolutionError } = response;
        if (!active || requestId !== locationRequestRef.current) return;
        if (resolutionError) throw resolutionError;
        const row = Array.isArray(data) ? data[0] : data;
        if (!row || !row.resolution_status || row.resolution_status === 'unavailable') {
          setSelectedPlaceIds({ siteId: null, zoneId: null });
          setGeofenceResolution({ resolutionStatus: 'unavailable', siteId: null, zoneId: null });
          hasResolution = true;
          setLocationStatus('unavailable');
          setLocationError('The service geofence response was not confirmed.');
          return;
        }
        const zoneId = row.matched_zone_id ?? null;
        const siteId = row.site_id ?? null;
        const { agreementLocationLinks: currentLinks, selectedAgreementSites: currentSites, selectedAgreementZones: currentZones, sites: currentAllSites, zones: currentAllZones } = locationScopeRef.current;
        const activeLink = activeShiftLocationContext?.serviceAgreementLocationId
          ? currentLinks.find((item) => item.id === activeShiftLocationContext.serviceAgreementLocationId) ?? null
          : null;
        const matchedAgreementZone = zoneId && currentZones.some((zone) => zone.id === zoneId);
        const matchedAgreementSite = siteId && currentSites.some((site) => site.id === siteId);
        const matchesActiveShiftPlace = activeShiftLocationContext
          ? activeLink
            ? activeLink.site_id ? activeLink.site_id === siteId : activeLink.zone_id === zoneId
            : Boolean(siteId && activeShiftLocationContext.siteIds.includes(siteId))
              || Boolean(zoneId && activeShiftLocationContext.zoneIds.includes(zoneId))
          : null;
        setGeofenceResolution({ resolutionStatus: row.resolution_status, siteId, zoneId });
        hasResolution = true;
        if (activeShiftLocationContext && !matchesActiveShiftPlace) {
          setSelectedPlaceIds({ siteId: null, zoneId: null });
          setLocationStatus(row.resolution_status === 'outside_all_geofences' ? 'outside_geofence' : 'unavailable');
          setLocationError('The resolved place does not match the active shift location.');
        } else if (matchesActiveShiftPlace || matchedAgreementZone || matchedAgreementSite) {
          setSelectedPlaceIds({ siteId, zoneId });
          setLocationStatus('resolved');
        } else {
          setSelectedPlaceIds({ siteId: null, zoneId: null });
          setLocationStatus('outside_geofence');
        }
        if (zoneId && !currentAllZones.some((zone) => zone.id === zoneId)) {
          void supabase.from('location_zones')
            .select('id,name,zone_type,location_id,organization_id,is_active,module_key')
            .eq('id', zoneId)
            .maybeSingle()
            .then(({ data: zone, error }) => {
              if (!active || requestId !== locationRequestRef.current || error || !zone) return;
              const site = currentAllSites.find((item) => item.id === siteId);
              if (site?.location_id && site.location_id !== zone.location_id) return;
              if (moduleKey && zone.module_key !== moduleKey) return;
              setZones((current) => current.some((item) => item.id === zone.id) ? current : [...current, {
                id: zone.id,
                name: zone.name,
                zone_type: zone.zone_type ?? null,
                location_id: zone.location_id ?? null,
                organization_id: zone.organization_id ?? null,
                is_active: Boolean(zone.is_active),
                module_key: zone.module_key ?? null,
                service_agreement_id: activeLink?.service_agreement_id ?? null,
              }]);
            });
        }
      } catch (locationLoadError) {
        if (!active || requestId !== locationRequestRef.current) return;
        hasResolution = true;
        setLocationStatus('unavailable');
        setLocationError(locationLoadError instanceof Error ? locationLoadError.message : 'Geofence location could not be resolved.');
      } finally {
        if (geofenceTimeoutId !== null) {
          window.clearTimeout(geofenceTimeoutId);
          geofenceTimeoutId = null;
        }
        if (requestId === locationRequestRef.current) geofenceRequestInFlight = false;
      }
    };

    const requestCurrentLocation = () => {
      if (!active || geofenceRequestInFlight) return;
      geofenceRequestInFlight = true;
      if (!hasResolution) setLocationStatus('locating');
      const requestId = locationRequestRef.current + 1;
      locationRequestRef.current = requestId;
      navigator.geolocation.getCurrentPosition((position) => {
        if (!active || requestId !== locationRequestRef.current) {
          geofenceRequestInFlight = false;
          return;
        }
        const coordinates = { lat: position.coords.latitude, lng: position.coords.longitude };
        latestCoordinates = coordinates;
        setCurrentCoordinates(coordinates);
        setLocationError(null);
        scheduleAddressRefresh();
        if (!serviceContextReady) {
          setLocationStatus('locating');
          return;
        }
        void resolveGeofence(coordinates, requestId);
      }, (positionError) => {
        if (!active || requestId !== locationRequestRef.current) return;
        geofenceRequestInFlight = false;
        hasResolution = true;
        setLocationStatus('unavailable');
        setLocationError(positionError.message || 'Location permission was not granted.');
      }, { enableHighAccuracy: true, maximumAge: 5_000, timeout: 15_000 });
    };

    requestCurrentLocation();
    const refreshTimer = window.setInterval(requestCurrentLocation, LOCATION_REFRESH_MS);
    return () => {
      active = false;
      locationRequestRef.current += 1;
      window.clearInterval(refreshTimer);
      if (geofenceTimeoutId !== null) window.clearTimeout(geofenceTimeoutId);
      if (addressRefreshTimer !== null) window.clearTimeout(addressRefreshTimer);
    };
  }, [activeShiftLocationContext, loadedOrganizationId, loading, locationMode, profile?.organizationId, profile?.role]);

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
    loadedOrganizationId,
    error,
    locationStatus,
    currentCoordinates,
    currentAddress,
    geofenceResolution,
    locationError,
    locationMode,
    refetch,
    setLocationMode,
    setActiveShiftLocationContext,
    selectAgreement: (agreementId) => {
      setSelectedAgreementId(agreementId);
      const links = agreementLocationLinks.filter((link) => link.service_agreement_id === agreementId);
      const siteIds = new Set(links.map((link) => link.site_id).filter(Boolean));
      const zoneIds = new Set(links.map((link) => link.zone_id).filter(Boolean));
      const zoneId = zones.find((zone) => zoneIds.has(zone.id))?.id ?? null;
      setSelectedPlaceIds(zoneId
        ? { siteId: null, zoneId }
        : { siteId: sites.find((site) => siteIds.has(site.id))?.id ?? null, zoneId: null });
    },
    selectAgreementLocation: (locationId) => {
      const link = agreementLocationLinks.find((item) => item.id === locationId);
      if (!link) return;
      setSelectedAgreementId(link.service_agreement_id);
      setSelectedPlaceIds(link.zone_id
        ? { siteId: null, zoneId: link.zone_id }
        : { siteId: link.site_id, zoneId: null });
    },
    selectSite: (siteId) => {
      setSelectedPlaceIds({ siteId, zoneId: null });
    },
    selectZone: (zoneId) => {
      setSelectedPlaceIds({ siteId: null, zoneId });
    },
  }), [agreements, sites, zones, agreementLocationLinks, selectedAgreementId, selectedSiteId, selectedZoneId, selectedAgreement, selectedSite, selectedZone, selectedAgreementSites, selectedAgreementZones, loading, loadedOrganizationId, error, locationStatus, currentCoordinates, currentAddress, geofenceResolution, locationError, locationMode, refetch, setActiveShiftLocationContext]);

  return <ServiceRelationshipContext.Provider value={value}>{children}</ServiceRelationshipContext.Provider>;
}

export function useServiceRelationships() {
  return useContext(ServiceRelationshipContext);
}
