import { useMemo, useState } from 'react';
import { LandPlot, MapPin, MapPinned, Search } from 'lucide-react';
import './PlaceFacetPicker.css';

export interface PlacePickerHouse {
  id: string;
  name: string;
  address: string | null;
}

export interface PlacePickerSite {
  id: string;
  name: string;
  address: string | null;
  location_id: string;
}

export interface PlacePickerZone {
  id: string;
  name: string;
  location_id: string;
  module_key?: string | null;
  zone_type?: string | null;
}

export interface PlaceFacetSelection {
  locationId: string;
  siteId: string | null;
  zoneId: string | null;
}

type PlaceOption = PlaceFacetSelection & {
  key: string;
  kind: 'site' | 'zone' | 'place';
  name: string;
  parentName: string;
  address: string | null;
  detail: string | null;
};

export function buildPlaceOptions(houses: PlacePickerHouse[], sites: PlacePickerSite[], zones: PlacePickerZone[]): PlaceOption[] {
  const housesById = new Map(houses.map((house) => [house.id, house]));
  const locationIdsWithFacets = new Set([...sites.map((site) => site.location_id), ...zones.map((zone) => zone.location_id)]);
  return [
    ...sites.flatMap((site): PlaceOption[] => {
      const house = housesById.get(site.location_id);
      return house ? [{
        key: `site:${site.id}`,
        kind: 'site',
        name: site.name,
        parentName: house.name,
        address: site.address ?? house.address,
        detail: null,
        locationId: house.id,
        siteId: site.id,
        zoneId: null,
      }] : [];
    }),
    ...zones.flatMap((zone): PlaceOption[] => {
      const house = housesById.get(zone.location_id);
      return house ? [{
        key: `zone:${zone.id}`,
        kind: 'zone',
        name: zone.name,
        parentName: house.name,
        address: house.address,
        detail: zone.module_key?.replaceAll('_', ' ') ?? zone.zone_type?.replaceAll('_', ' ') ?? null,
        locationId: house.id,
        siteId: null,
        zoneId: zone.id,
      }] : [];
    }),
    ...houses.filter((house) => !locationIdsWithFacets.has(house.id)).map((house): PlaceOption => ({
      key: `place:${house.id}`,
      kind: 'place',
      name: house.name,
      parentName: house.name,
      address: house.address,
      detail: 'No active site or zone facet',
      locationId: house.id,
      siteId: null,
      zoneId: null,
    })),
  ].sort((left, right) => left.name.localeCompare(right.name) || left.kind.localeCompare(right.kind));
}

function selectionKey(selection: PlaceFacetSelection | null): string | null {
  if (!selection) return null;
  if (selection.zoneId) return `zone:${selection.zoneId}`;
  if (selection.siteId) return `site:${selection.siteId}`;
  return `place:${selection.locationId}`;
}

export function PlaceFacetPicker({ houses, sites, zones, value, onChange, disabled = false, loading = false, label = 'Places' }: {
  houses: PlacePickerHouse[];
  sites: PlacePickerSite[];
  zones: PlacePickerZone[];
  value: PlaceFacetSelection | null;
  onChange: (selection: PlaceFacetSelection) => void;
  disabled?: boolean;
  loading?: boolean;
  label?: string;
}) {
  const [query, setQuery] = useState('');
  const options = useMemo(() => buildPlaceOptions(houses, sites, zones), [houses, sites, zones]);
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return options.slice(0, 100);
    return options.filter((option) => `${option.kind} ${option.name} ${option.parentName} ${option.address ?? ''} ${option.detail ?? ''}`.toLowerCase().includes(normalized)).slice(0, 100);
  }, [options, query]);
  const activeKey = selectionKey(value);

  return <div className="place-facet-picker">
    <label className="place-facet-picker__search">
      <Search size={15} aria-hidden="true" />
      <span className="sr-only">Search sites and zones</span>
      <input type="search" value={query} placeholder="Search sites, zones, or addresses" onChange={(event) => setQuery(event.target.value)} disabled={disabled} />
    </label>
    <div className="place-facet-picker__list" role="listbox" aria-label={label}>
      {loading ? <p className="place-facet-picker__empty">Loading sites and zones...</p> : null}
      {!loading && filtered.length === 0 ? <p className="place-facet-picker__empty">No sites or zones match this search.</p> : null}
      {filtered.map((option) => {
        const Icon = option.kind === 'site' ? MapPin : option.kind === 'zone' ? LandPlot : MapPinned;
        return <button
          key={option.key}
          type="button"
          role="option"
          aria-selected={option.key === activeKey}
          className={`place-facet-picker__option${option.key === activeKey ? ' is-selected' : ''}`}
          disabled={disabled}
          onClick={() => onChange({ locationId: option.locationId, siteId: option.siteId, zoneId: option.zoneId })}
        >
          <Icon size={16} aria-hidden="true" />
          <span className="place-facet-picker__copy">
            <span><strong>{option.name}</strong><em>{option.kind}</em></span>
            <small>{option.kind === 'place' ? option.address ?? option.detail : `${option.parentName}${option.address ? ` · ${option.address}` : ''}${option.detail ? ` · ${option.detail}` : ''}`}</small>
          </span>
        </button>;
      })}
    </div>
  </div>;
}