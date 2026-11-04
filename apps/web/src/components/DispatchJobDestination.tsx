import { ExternalLink, MapPin, MapPinOff } from 'lucide-react';
import { DESTINATION_SOURCE_TEXT, type DispatchDestination } from '../lib/dispatchJobLocation';

/**
 * Where to go for one dispatch job. Maps always open in a new tab / the phone's
 * maps app (target=_blank) so the officer portal is never unloaded mid-job.
 */
export function DispatchJobDestination({ destination }: { destination: DispatchDestination }) {
  if (destination.kind === 'none') {
    return (
      <p className="officer-job-destination is-none" role="status">
        <MapPinOff size={18} aria-hidden="true" />
        <span><strong>No map location for this job.</strong> No site, zone position or address was recorded — ask dispatch where to attend.</span>
      </p>
    );
  }
  const where = destination.kind === 'address' ? destination.address : `${destination.lat.toFixed(5)}, ${destination.lng.toFixed(5)}`;
  return (
    <div className="officer-job-destination">
      <p>
        <MapPin size={18} aria-hidden="true" />
        <span><strong>{where}</strong><small>{DESTINATION_SOURCE_TEXT[destination.source] ?? 'Job location'}</small></span>
      </p>
      <a className="btn btn-secondary officer-job-maps-link" href={destination.mapsUrl} target="_blank" rel="noopener noreferrer">
        <ExternalLink size={18} aria-hidden="true" />Open in Maps
      </a>
    </div>
  );
}
