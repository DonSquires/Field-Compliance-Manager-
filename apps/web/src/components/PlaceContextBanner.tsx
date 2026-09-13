import React from 'react';
import { MapPin, Navigation, ShieldAlert } from 'lucide-react';
import { useServiceRelationships } from '../context/ServiceRelationshipContext';
import './PlaceContextBanner.css';

export function PlaceContextBanner() {
  const { locationStatus, currentCoordinates, currentAddress, locationError, selectedSite, selectedZone } = useServiceRelationships();

  const coordinates = currentCoordinates
    ? `${currentCoordinates.lat.toFixed(5)}, ${currentCoordinates.lng.toFixed(5)}`
    : 'Unavailable';
  const placeName = selectedZone?.name ?? selectedSite?.name ?? 'No verified service place';
  const heading = locationStatus === 'resolved'
    ? 'Current location evidence'
    : locationStatus === 'outside_geofence'
      ? 'Outside the selected service geofence'
      : locationStatus === 'unavailable'
        ? 'Location evidence unavailable'
        : 'Resolving current location evidence';

  return (
    <div className={`place-context-banner is-${locationStatus}`} role="status" data-place-context-status={locationStatus}>
      <ShieldAlert size={18} aria-hidden="true" />
      <div>
        <strong>{heading}</strong>
        <span>{locationError ?? `Place: ${placeName}`}</span>
        <small><Navigation size={13} aria-hidden="true" /> GPS: {coordinates} <MapPin size={13} aria-hidden="true" /> Address: {currentAddress ?? 'Resolving physical address'}</small>
      </div>
    </div>
  );
}
