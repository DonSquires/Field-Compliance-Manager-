import React from 'react';
import { Car, UserRound } from 'lucide-react';
import { formatNzDate } from '../lib/personSearch';
import {
  permitAnswer,
  permitValidity,
  permitValidityLabel,
  permitValidityTone,
  type PermitSummary,
  type PermitVehicle,
} from '../lib/permits';
import './PermitAccessCard.css';

interface PermitAccessCardProps {
  permit: PermitSummary;
  /** Show who holds the permit (vehicle views); the person record already names them. */
  showHolder?: boolean;
  /** Show the contact details captured on the application (person record only). */
  showContact?: boolean;
  /** The plate being viewed, so the card lists only the other vehicles on the permit. */
  currentPlate?: string | null;
  onOpenVehicle?: (vehicle: PermitVehicle) => void;
  onOpenPerson?: (permit: PermitSummary) => void;
  actionsDisabled?: boolean;
}

const plateKey = (plate: string) => plate.replace(/[^a-z0-9]/gi, '').toUpperCase();

export const PermitAccessCard: React.FC<PermitAccessCardProps> = ({
  permit,
  showHolder = false,
  showContact = false,
  currentPlate = null,
  onOpenVehicle,
  onOpenPerson,
  actionsDisabled = false,
}) => {
  const validity = permitValidity(permit);
  const tone = permitValidityTone(validity);
  const titleId = `permit-card-${permit.id}`;
  const areas = permit.forest_areas ?? [];
  const activities = permit.activities ?? [];
  const vehicles = (permit.vehicles ?? []).filter(
    (vehicle) => !currentPlate || plateKey(vehicle.plate_number) !== plateKey(currentPlate),
  );
  const summary = [
    permit.permit_type,
    showHolder ? permit.holder_name || 'Holder not recorded' : null,
    permit.company_name,
    permit.client_organization_name ? `for ${permit.client_organization_name}` : null,
  ].filter(Boolean).join(' · ');
  const hasContact = showContact && Boolean(permit.contact_email || permit.contact_phone || permit.address_text);
  const hasSource = Boolean(permit.source_document || permit.compliance_checked_at);

  return (
    <article className={`permit-card is-${tone}`} aria-labelledby={titleId}>
      <header className="permit-card__head">
        <div>
          <h4 id={titleId}>Permit {permit.permit_number}</h4>
          {summary && <p>{summary}</p>}
        </div>
        <div className="permit-card__badges">
          <span className={`permit-card__badge is-${tone}`}>{permitValidityLabel(validity)}</span>
          {permit.firearm_licence_valid === false && (
            <span className="permit-card__badge is-critical">No valid firearms licence</span>
          )}
        </div>
      </header>

      <dl className="permit-card__facts">
        <div><dt>Starts</dt><dd>{formatNzDate(permit.date_from ?? null)}</dd></div>
        <div><dt>Finishes</dt><dd>{formatNzDate(permit.date_to ?? null)}</dd></div>
        {permit.hunting_season && <div><dt>Hunting season</dt><dd>{permit.hunting_season}</dd></div>}
        <div><dt>Firearm licence</dt><dd>{permitAnswer(permit.firearm_licence_valid, 'Valid', 'Not valid')}</dd></div>
        <div><dt>Chainsaw safety gear</dt><dd>{permitAnswer(permit.chainsaw_safety_equipment)}</dd></div>
        <div><dt>Keys issued</dt><dd>{permitAnswer(permit.keys_issued)}</dd></div>
      </dl>

      {(areas.length > 0 || activities.length > 0) && (
        <dl className="permit-card__lists">
          {areas.length > 0 && <div><dt>Areas</dt><dd>{areas.join(', ')}</dd></div>}
          {activities.length > 0 && <div><dt>Activities</dt><dd>{activities.join(', ')}</dd></div>}
        </dl>
      )}

      {permit.conditions && (
        <div className="permit-card__block">
          <strong>Conditions</strong>
          <p className="permit-card__conditions">{permit.conditions}</p>
        </div>
      )}

      {hasContact && (
        <div className="permit-card__block">
          <strong>Captured on the application</strong>
          <dl className="permit-card__lists">
            {permit.contact_email && <div><dt>Email</dt><dd>{permit.contact_email}</dd></div>}
            {permit.contact_phone && <div><dt>Phone</dt><dd>{permit.contact_phone}</dd></div>}
            {permit.address_text && <div><dt>Address</dt><dd>{permit.address_text}</dd></div>}
          </dl>
        </div>
      )}

      {vehicles.length > 0 && (
        <div className="permit-card__block">
          <strong>{currentPlate ? 'Other vehicles on this permit' : 'Vehicles on this permit'}</strong>
          <ul className="permit-card__vehicles">
            {vehicles.map((vehicle) => {
              const description = [vehicle.colour, vehicle.make, vehicle.model].filter(Boolean).join(' ');
              return (
                <li key={vehicle.canonical_vehicle_id ?? vehicle.plate_number}>
                  <span className="permit-card__plate">{vehicle.plate_number}</span>
                  {description && <span className="permit-card__muted">{description}</span>}
                  {onOpenVehicle && vehicle.canonical_vehicle_id && (
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm permit-card__action"
                      onClick={() => onOpenVehicle(vehicle)}
                      disabled={actionsDisabled}
                      aria-label={`Open vehicle ${vehicle.plate_number}`}
                    >
                      <Car size={14} aria-hidden="true" /> Open vehicle
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {(hasSource || (onOpenPerson && permit.canonical_person_id)) && (
        <footer className="permit-card__foot">
          {hasSource && (
            <p className="permit-card__muted">
              Source: {permit.source_document || 'Permit register'}
              {permit.compliance_checked_at ? `, checked ${formatNzDate(permit.compliance_checked_at)}` : ''}
            </p>
          )}
          {onOpenPerson && permit.canonical_person_id && (
            <button
              type="button"
              className="btn btn-secondary btn-sm permit-card__action"
              onClick={() => onOpenPerson(permit)}
              disabled={actionsDisabled}
              aria-label={permit.holder_name ? `Open person record for ${permit.holder_name}` : undefined}
            >
              <UserRound size={14} aria-hidden="true" /> Open person record
            </button>
          )}
        </footer>
      )}
    </article>
  );
};

export default PermitAccessCard;
