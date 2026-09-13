import React from 'react';
import { MapPin, Navigation, ShieldAlert } from 'lucide-react';
import { useServiceRelationships } from '../context/ServiceRelationshipContext';
import './PlaceContextBanner.css';

export function PlaceContextBanner() {
  const { locationStatus, currentCoordinates, currentAddress, locationError } = useServiceRelationships();
  if (locationStatus !== 'outside_geofence' && locationStatus !== 'unavailable') return null;

  const coordinates = currentCoordinates
    ? `${currentCoordinates.lat.toFixed(5)}, ${currentCoordinates.lng.toFixed(5)}`
    : 'Unavailable';

  return (
    <div className="place-context-banner" role="status" data-place-context-status={locationStatus}>
      <ShieldAlert size={18} aria-hidden="true" />
      <div>
        <strong>{locationStatus === 'outside_geofence' ? 'Outside the selected service geofence' : 'Place selection needs location evidence'}</strong>
        <span>{locationError ?? 'No active agreement site or zone contains the current position.'}</span>
        <small><Navigation size={13} aria-hidden="true" /> GPS: {coordinates} <MapPin size={13} aria-hidden="true" /> Address: {currentAddress ?? 'Resolving physical address'}</small>
      </div>
    </div>
  );
}
