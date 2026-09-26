import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { FilePlus2, Search, ShieldCheck, X } from 'lucide-react';
import type { ServiceAgreementContextRow } from '../context/ServiceRelationshipContext';
import { supabase } from '../lib/supabase';
import './CustomReportBuilder.css';

interface ScopeOption {
  id: string;
  name?: string;
  address?: string | null;
  plate?: string;
  make?: string | null;
  model?: string | null;
}

interface CustomReportScopeOptions {
  sites: ScopeOption[];
  zones: ScopeOption[];
  people: ScopeOption[];
  vehicles: ScopeOption[];
  supported_sections: string[];
}

interface CustomReportResult {
  id: string;
  status: 'draft';
  observation_count: number;
  breach_count: number;
}

interface CustomReportBuilderProps {
  agreements: ServiceAgreementContextRow[];
  initialAgreementId: string | null;
  periodStart: string;
  periodEnd: string;
  onClose: () => void;
  onCreated: (message: string, agreementId: string) => Promise<void> | void;
}

interface ScopeGroupProps {
  id: string;
  legend: string;
  emptyLabel: string;
  options: ScopeOption[];
  selectedIds: string[];
  getLabel: (option: ScopeOption) => string;
  onChange: (ids: string[]) => void;
}

const DEFAULT_SECTIONS = ['summary', 'observations', 'breaches'];
const PLACE_ONLY_SECTIONS = new Set(['incidents', 'checkpoint_visits']);
const SECTION_LABELS: Record<string, string> = {
  summary: 'Summary',
  observations: 'Observation details',
  breaches: 'Breach details',
  incidents: 'Incident register',
  checkpoint_visits: 'Checkpoint visits',
};

function ScopeGroup({ id, legend, emptyLabel, options, selectedIds, getLabel, onChange }: ScopeGroupProps) {
  const [query, setQuery] = useState('');
  const filteredOptions = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase('en-NZ');
    if (!normalizedQuery) return options;
    return options.filter((option) => getLabel(option).toLocaleLowerCase('en-NZ').includes(normalizedQuery));
  }, [getLabel, options, query]);

  const toggle = (optionId: string) => {
    onChange(selectedIds.includes(optionId)
      ? selectedIds.filter((idValue) => idValue !== optionId)
      : [...selectedIds, optionId]);
  };

  return (
    <fieldset className="custom-report-scope-group">
      <legend>{legend} <span>{selectedIds.length} selected</span></legend>
      <label className="custom-report-search" htmlFor={`${id}-search`}>
        <Search size={15} aria-hidden="true" />
        <span className="sr-only">Search {legend.toLocaleLowerCase('en-NZ')}</span>
        <input
          id={`${id}-search`}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={`Search ${legend.toLocaleLowerCase('en-NZ')}`}
        />
      </label>
      <div className="custom-report-scope-actions">
        <button type="button" onClick={() => onChange([...new Set([...selectedIds, ...filteredOptions.map((option) => option.id)])])} disabled={filteredOptions.length === 0}>Select results</button>
        <button type="button" onClick={() => onChange([])} disabled={selectedIds.length === 0}>Clear</button>
      </div>
      <div className="custom-report-option-list">
        {filteredOptions.length === 0 ? <p>{emptyLabel}</p> : filteredOptions.map((option) => (
          <label key={option.id}>
            <input type="checkbox" checked={selectedIds.includes(option.id)} onChange={() => toggle(option.id)} />
            <span>{getLabel(option)}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function CustomReportBuilder({ agreements, initialAgreementId, periodStart, periodEnd, onClose, onCreated }: CustomReportBuilderProps) {
  const eligibleAgreements = useMemo(
    () => agreements.filter((agreement) => agreement.invitation_status === 'accepted' && agreement.agreement_type === 'operational'),
    [agreements]
  );
  const initialEligibleAgreementId = eligibleAgreements.some((agreement) => agreement.id === initialAgreementId)
    ? initialAgreementId ?? ''
    : eligibleAgreements[0]?.id ?? '';
  const [agreementId, setAgreementId] = useState(initialEligibleAgreementId);
  const [title, setTitle] = useState(`Custom report - ${periodStart} to ${periodEnd}`);
  const [options, setOptions] = useState<CustomReportScopeOptions | null>(null);
  const [siteIds, setSiteIds] = useState<string[]>([]);
  const [zoneIds, setZoneIds] = useState<string[]>([]);
  const [personIds, setPersonIds] = useState<string[]>([]);
  const [vehicleIds, setVehicleIds] = useState<string[]>([]);
  const [sections, setSections] = useState<string[]>(DEFAULT_SECTIONS);
  const [loadingOptions, setLoadingOptions] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasEntityScope = personIds.length > 0 || vehicleIds.length > 0;
  const hasPersonalSections = sections.some((section) => ['observations', 'breaches', 'incidents', 'checkpoint_visits'].includes(section));

  useEffect(() => {
    if (initialAgreementId && eligibleAgreements.some((agreement) => agreement.id === initialAgreementId)) {
      setAgreementId(initialAgreementId);
      return;
    }
    setAgreementId((current) => eligibleAgreements.some((agreement) => agreement.id === current)
      ? current
      : eligibleAgreements[0]?.id ?? '');
  }, [eligibleAgreements, initialAgreementId]);

  useEffect(() => {
    if (!agreementId || !periodStart || !periodEnd) {
      setOptions(null);
      return;
    }
    let cancelled = false;
    setLoadingOptions(true);
    setError(null);
    setSiteIds([]);
    setZoneIds([]);
    setPersonIds([]);
    setVehicleIds([]);
    void supabase.rpc('get_custom_report_scope_options', {
      p_service_agreement_id: agreementId,
      p_period_start: periodStart,
      p_period_end: periodEnd,
    }).then(({ data, error: optionsError }) => {
      if (cancelled) return;
      if (optionsError || !data) {
        setOptions(null);
        setError(optionsError?.message ?? 'Custom report scope could not be loaded.');
      } else {
        setOptions(data as unknown as CustomReportScopeOptions);
      }
      setLoadingOptions(false);
    });
    return () => { cancelled = true; };
  }, [agreementId, periodEnd, periodStart]);

  useEffect(() => {
    if (hasEntityScope) {
      setSections((current) => current.filter((section) => !PLACE_ONLY_SECTIONS.has(section)));
    }
  }, [hasEntityScope]);

  const toggleSection = (section: string) => {
    setSections((current) => current.includes(section)
      ? current.filter((value) => value !== section)
      : [...current, section]);
  };

  const createDraft = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!agreementId || !title.trim() || sections.length === 0) {
      setError('Choose an agreement, add a title, and select at least one section.');
      return;
    }
    setCreating(true);
    setError(null);
    const { data, error: generationError } = await supabase.rpc('generate_custom_report_pack', {
      p_service_agreement_id: agreementId,
      p_period_start: periodStart,
      p_period_end: periodEnd,
      p_title: title,
      p_site_ids: siteIds,
      p_zone_ids: zoneIds,
      p_person_ids: personIds,
      p_vehicle_ids: vehicleIds,
      p_sections: sections,
    });
    if (generationError || !data) {
      setError(generationError?.message ?? 'Custom report draft could not be created.');
      setCreating(false);
      return;
    }
    const result = data as unknown as CustomReportResult;
    await onCreated(`Custom report draft created with ${result.observation_count} observations and ${result.breach_count} linked breaches.`, agreementId);
    setCreating(false);
  };

  const availableSections = options?.supported_sections ?? ['summary', 'observations', 'breaches', 'incidents', 'checkpoint_visits'];
  const selectedScopeCount = siteIds.length + zoneIds.length + personIds.length + vehicleIds.length;

  return (
    <section className="custom-report-builder" aria-labelledby="custom-report-builder-title">
      <header className="custom-report-builder-heading">
        <div>
          <span className="custom-report-kicker"><FilePlus2 size={16} aria-hidden="true" /> Custom report</span>
          <h2 id="custom-report-builder-title">Build a governed report draft</h2>
          <p>One client agreement per report. Source facts remain read-only through review and publication.</p>
        </div>
        <button type="button" className="btn btn-secondary" onClick={onClose} title="Close custom report builder"><X size={17} aria-hidden="true" /><span className="sr-only">Close custom report builder</span></button>
      </header>

      {error && <div className="alert alert-error" role="alert">{error}</div>}
      {eligibleAgreements.length === 0 && <div className="alert alert-info" role="status">No accepted operational agreement is available for a custom report.</div>}

      <form onSubmit={createDraft}>
        <div className="custom-report-foundation">
          <label>
            <span>Service agreement</span>
            <select value={agreementId} onChange={(event) => setAgreementId(event.target.value)} disabled={eligibleAgreements.length === 0} required>
              <option value="">Choose an accepted agreement</option>
              {eligibleAgreements.map((agreement) => <option key={agreement.id} value={agreement.id}>{agreement.client_name ? `${agreement.client_name} · ` : ''}{agreement.name}</option>)}
            </select>
          </label>
          <label>
            <span>Report title</span>
            <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={160} required />
            <small>{title.length}/160</small>
          </label>
        </div>

        {loadingOptions ? <output className="custom-report-loading">Loading agreement scope...</output> : options && (
          <>
            <div className="custom-report-scope-summary">
              <strong>{selectedScopeCount === 0 ? 'All agreement activity' : `${selectedScopeCount} scoped records`}</strong>
              <span>Any selected Site or Zone, and any selected Person, and any selected Vehicle.</span>
            </div>

            <div className="custom-report-scope-grid">
              <ScopeGroup id="custom-sites" legend="Sites" emptyLabel="No active Sites are linked to this agreement." options={options.sites} selectedIds={siteIds} getLabel={(option) => option.address ? `${option.name} · ${option.address}` : option.name ?? 'Unnamed Site'} onChange={setSiteIds} />
              <ScopeGroup id="custom-zones" legend="Zones" emptyLabel="No active Zones are linked to this agreement." options={options.zones} selectedIds={zoneIds} getLabel={(option) => option.name ?? 'Unnamed Zone'} onChange={setZoneIds} />
              <ScopeGroup id="custom-people" legend="People" emptyLabel="No people have agreement-linked observations in this period." options={options.people} selectedIds={personIds} getLabel={(option) => option.name ?? 'Unnamed person'} onChange={setPersonIds} />
              <ScopeGroup id="custom-vehicles" legend="Vehicles" emptyLabel="No vehicles have agreement-linked observations in this period." options={options.vehicles} selectedIds={vehicleIds} getLabel={(option) => [option.plate, option.make, option.model].filter(Boolean).join(' · ')} onChange={setVehicleIds} />
            </div>

            {(hasEntityScope || hasPersonalSections) && <p className="custom-report-privacy"><ShieldCheck size={17} aria-hidden="true" /> Detailed and entity-scoped reports are personal information. They include only linked operational facts and public identity labels; private identity attributes are excluded. Incident and checkpoint sections require place-only scope.</p>}

            <fieldset className="custom-report-sections">
              <legend>Report sections</legend>
              {availableSections.map((section) => {
                const disabled = hasEntityScope && PLACE_ONLY_SECTIONS.has(section);
                return (
                  <label key={section}>
                    <input type="checkbox" checked={sections.includes(section)} disabled={disabled} onChange={() => toggleSection(section)} />
                    <span>{SECTION_LABELS[section] ?? section}</span>
                  </label>
                );
              })}
            </fieldset>
          </>
        )}

        <footer className="custom-report-footer">
          <span>The generated snapshot opens in the existing provider review queue.</span>
          <button type="submit" className="btn btn-primary" disabled={eligibleAgreements.length === 0 || creating || loadingOptions || !options || sections.length === 0}>
            <FilePlus2 size={17} aria-hidden="true" /> {creating ? 'Creating draft...' : 'Create review draft'}
          </button>
        </footer>
      </form>
    </section>
  );
}