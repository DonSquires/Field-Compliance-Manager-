import React from 'react';
import { MapPin, Navigation, ShieldAlert } from 'lucide-react';
import { useServiceRelationships } from '../context/ServiceRelationshipContext';
import './PlaceContextBanner.css';

export function PlaceContextBanner({ compact = false, organizationWide = false, organizationId }: { compact?: boolean; organizationWide?: boolean; organizationId?: string | null }) {
  const {
    locationStatus, currentCoordinates, currentAddress, locationError, locationMode,
    geofenceResolution, selectedAgreementSites, selectedAgreementZones, selectedSite, selectedZone, selectSite, selectZone,
    agreements, selectedAgreement, selectAgreement, loading, error, refetch, loadedOrganizationId,
  } = useServiceRelationships();

  const coordinates = currentCoordinates
    ? `${currentCoordinates.lat.toFixed(5)}, ${currentCoordinates.lng.toFixed(5)}`
    : 'Unavailable';
  const placeName = selectedZone?.name ?? selectedSite?.name ?? 'No verified service place';
  const resolutionStatus = geofenceResolution?.resolutionStatus ?? null;
  const resolutionHeading: Record<string, string> = {
    outside_all_geofences: 'Outside all verified service geofences',
    unresolved_no_geofence: 'No service geofence is configured here',
    unresolved_unverified: 'The service boundary is not verified',
    unresolved_invalid: 'The service boundary is invalid',
  };
  const resolutionMessage: Record<string, string> = {
    outside_all_geofences: 'GPS is outside every verified Site and Zone for the selected agreement.',
    unresolved_no_geofence: 'An administrator must configure this Site or Zone in the Geofence Workbench.',
    unresolved_unverified: 'An administrator must visually verify this Site or Zone in the Geofence Workbench before it can auto-select.',
    unresolved_invalid: 'An administrator must redraw or re-import this Site or Zone boundary in the Geofence Workbench.',
  };
  const heading = locationMode === 'manual'
    ? selectedSite || selectedZone ? 'Selected service place' : 'Select a service place'
    : resolutionStatus && resolutionHeading[resolutionStatus]
      ? resolutionHeading[resolutionStatus]
      : locationStatus === 'resolved'
    ? 'Current location evidence'
    : locationStatus === 'outside_geofence'
        ? 'Service geofence could not be confirmed'
      : locationStatus === 'unavailable'
        ? 'Location evidence unavailable'
        : 'Resolving current location evidence';

  if (compact) return <div className="place-context-banner is-console" role="region" aria-label="Service place context">
    <MapPin size={14} aria-hidden="true" />
    {organizationWide ? <span>Organisation-wide evidence workspace · not filtered by service place</span> : error ? <><span>Service context unavailable</span><button type="button" onClick={() => void refetch()}>Retry</button></> : !loading && organizationId && organizationId !== loadedOrganizationId ? <span>Service place context unavailable for this operating organisation</span> : <>
      <label><span className="sr-only">Service agreement</span><select aria-label="Service agreement" disabled={loading} value={selectedAgreement?.id ?? ''} onChange={(event) => selectAgreement(event.target.value || null)}>
        <option value="">{loading ? 'Loading service context…' : 'No agreement selected'}</option>
        {agreements.map((agreement) => <option key={agreement.id} value={agreement.id}>{agreement.name}</option>)}
      </select></label>
      <label><span className="sr-only">Service site or zone</span><select aria-label="Service site or zone" disabled={loading || !selectedAgreement} value={selectedZone ? `zone:${selectedZone.id}` : selectedSite ? `site:${selectedSite.id}` : ''} onChange={(event) => {
        const [kind, id] = event.target.value.split(':');
        if (kind === 'zone') selectZone(id);
        else if (kind === 'site') selectSite(id);
        else { selectSite(null); selectZone(null); }
      }}>
        <option value="">{selectedAgreementSites.length || selectedAgreementZones.length ? 'All agreement places' : 'No service places configured'}</option>
        {selectedAgreementSites.length > 0 && <optgroup label="Sites">{selectedAgreementSites.map((site) => <option key={site.id} value={`site:${site.id}`}>{site.name}</option>)}</optgroup>}
        {selectedAgreementZones.length > 0 && <optgroup label="Zones">{selectedAgreementZones.map((zone) => <option key={zone.id} value={`zone:${zone.id}`}>{zone.name}</option>)}</optgroup>}
      </select></label>
      <span className="place-context-console-mode">Planning context · not GPS proof</span>
    </>}
  </div>;

  return (
    <div className={`place-context-banner is-${locationStatus}`} role="note" aria-label={heading} data-place-context-status={locationStatus}>
      <ShieldAlert size={18} aria-hidden="true" />
      <div>
        <strong>{heading}</strong>
        {locationMode === 'manual' ? <label className="place-context-banner__picker">
          <MapPin size={14} aria-hidden="true" />
          <span className="sr-only">Service site or zone</span>
          <select
            aria-label="Service site or zone"
            value={selectedZone ? `zone:${selectedZone.id}` : selectedSite ? `site:${selectedSite.id}` : ''}
            onChange={(event) => {
              const [kind, id] = event.target.value.split(':');
              if (kind === 'zone') selectZone(id);
              else if (kind === 'site') selectSite(id);
              else { selectSite(null); selectZone(null); }
            }}
          >
            <option value="">Select a site or zone</option>
            {selectedAgreementSites.length > 0 ? <optgroup label="Sites">{selectedAgreementSites.map((site) => <option value={`site:${site.id}`} key={site.id}>{site.name}{site.address ? ` · ${site.address}` : ''}</option>)}</optgroup> : null}
            {selectedAgreementZones.length > 0 ? <optgroup label="Zones">{selectedAgreementZones.map((zone) => <option value={`zone:${zone.id}`} key={zone.id}>{zone.name}{zone.zone_type ? ` · ${zone.zone_type.replaceAll('_', ' ')}` : ''}</option>)}</optgroup> : null}
          </select>
        </label> : <>
          <span>{locationError ?? (resolutionStatus ? resolutionMessage[resolutionStatus] : null) ?? `Place: ${placeName}`}</span>
          <small><Navigation size={13} aria-hidden="true" /> GPS: {coordinates} <MapPin size={13} aria-hidden="true" /> Address: {currentAddress ?? 'Resolving physical address'}</small>
        </>}
      </div>
    </div>
  );
}
