import React from 'react';
import { MapPin, Navigation, ShieldAlert } from 'lucide-react';
import { useServiceRelationships } from '../context/ServiceRelationshipContext';
import './PlaceContextBanner.css';

export function PlaceContextBanner() {
  const {
    locationStatus, currentCoordinates, currentAddress, locationError, locationMode,
    selectedAgreementSites, selectedAgreementZones, selectedSite, selectedZone, selectSite, selectZone,
  } = useServiceRelationships();

  const coordinates = currentCoordinates
    ? `${currentCoordinates.lat.toFixed(5)}, ${currentCoordinates.lng.toFixed(5)}`
    : 'Unavailable';
  const placeName = selectedZone?.name ?? selectedSite?.name ?? 'No verified service place';
  const heading = locationMode === 'manual'
    ? selectedSite || selectedZone ? 'Selected service place' : 'Select a service place'
    : locationStatus === 'resolved'
    ? 'Current location evidence'
    : locationStatus === 'outside_geofence'
      ? 'Outside the selected service geofence'
      : locationStatus === 'unavailable'
        ? 'Location evidence unavailable'
        : 'Resolving current location evidence';

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
          <span>{locationError ?? `Place: ${placeName}`}</span>
          <small><Navigation size={13} aria-hidden="true" /> GPS: {coordinates} <MapPin size={13} aria-hidden="true" /> Address: {currentAddress ?? 'Resolving physical address'}</small>
        </>}
      </div>
    </div>
  );
}
