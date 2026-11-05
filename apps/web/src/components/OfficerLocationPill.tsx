import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useServiceRelationships } from '../context/ServiceRelationshipContext';
import { PlaceContextBanner } from './PlaceContextBanner';

export function OfficerLocationPill() {
  const { locationStatus, locationMode, currentAddress, selectedSite, selectedZone } = useServiceRelationships();
  const [open, setOpen] = useState(false);
  const placeName = selectedZone?.name ?? selectedSite?.name ?? null;
  const manual = locationMode === 'manual';
  const locating = !manual && (locationStatus === 'idle' || locationStatus === 'locating');
  const current = !manual && locationStatus === 'resolved';
  const label = manual ? 'Selected place' : locating ? 'Finding location' : current ? 'Current location' : 'No current location';
  const location = manual
    ? placeName ?? 'Not selected'
    : currentAddress
      ? `${locationStatus === 'unavailable' || locating ? 'Last known: ' : ''}${currentAddress}`
      : placeName ? `${current ? '' : 'Selected: '}${placeName}` : null;
  const tone = manual ? 'is-selected' : locating ? 'is-locating' : current ? 'is-current' : 'is-missing';

  return (
    <div className={`officer-location-pill ${tone}`}>
      <button type="button" aria-expanded={open} aria-controls="officer-location-details" onClick={() => setOpen((value) => !value)}>
        <span className="officer-location-dot" aria-hidden="true" />
        <strong>{label}</strong>
        {location && <span className="officer-location-where">{location}</span>}
        <ChevronDown size={18} aria-hidden="true" />
        <span className="sr-only">{open ? 'Hide location details' : 'Show location details'}</span>
      </button>
      <div id="officer-location-details" hidden={!open}><PlaceContextBanner /></div>
    </div>
  );
}
