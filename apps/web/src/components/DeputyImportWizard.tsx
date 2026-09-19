/**
 * DeputyImportWizard — walk an admin from a Deputy export to draft roster slots in four steps:
 * files -> people -> places -> review & import. Reads only; the single write is the governed
 * apply_deputy_roster_import RPC, which never creates people and only creates internal work units.
 */
import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, FileUp, MapPinned, RefreshCw, Users, X } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { locationGuidance, parseDeputyExport, type DeputyParseResult } from '../lib/deputyImport';
import './DeputyImportWizard.css';

export interface WizardStaff { staffId: string; name: string }
export interface WizardWorkUnit { id: string; name: string; work_unit_type: 'patrol' | 'static' | 'internal'; external_refs?: { deputy?: { code?: string; name?: string } } | null }
interface StaffRef { id: string; payroll_id: string | null; external_refs: { deputy_export_code?: string } | null }
type PlaceAction = { kind: 'match'; workUnitId: string } | { kind: 'create_internal' } | { kind: 'skip' };
interface Receipt { batch_id: string; work_units_created: number; work_units_matched: number; people_matched: number; slots_created: number; slots_already_imported: number; slots_unresolved: number; leave_created: number; leave_already_imported: number; leave_unresolved: number; timesheets_not_imported: number }

const STEPS = ['Files', 'People', 'Places', 'Review and import'] as const;
const norm = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function DeputyImportWizard({ operatingOrganizationId, staff, workUnits, onClose, onImported }: {
  operatingOrganizationId: string; staff: WizardStaff[]; workUnits: WizardWorkUnit[]; onClose: () => void; onImported?: () => void | Promise<void>;
}) {
  const [step, setStep] = useState(0);
  const [mainFile, setMainFile] = useState<File | null>(null);
  const [locationsFile, setLocationsFile] = useState<File | null>(null);
  const [parsed, setParsed] = useState<DeputyParseResult | null>(null);
  const [sourceHash, setSourceHash] = useState<string | null>(null);
  const [staffRefs, setStaffRefs] = useState<StaffRef[]>([]);
  const [peopleMap, setPeopleMap] = useState<Record<string, string>>({});
  const [placeMap, setPlaceMap] = useState<Record<string, PlaceAction>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);

  useEffect(() => {
    // ATLAS READS: staff_profiles (payroll id + Deputy export code for matching only)
    void supabase.from('staff_profiles').select('id,payroll_id,external_refs').eq('organization_id', operatingOrganizationId)
      .then(({ data }) => setStaffRefs((data as StaffRef[]) ?? []));
  }, [operatingOrganizationId]);

  const readFiles = async () => {
    if (!mainFile) { setError('Choose the Deputy timesheet and schedule export first.'); return; }
    setBusy(true); setError(null);
    try {
      const text = await mainFile.text();
      const result = await parseDeputyExport(text, locationsFile ? await locationsFile.text() : undefined);
      setSourceHash(await sha256Hex(text));
      setParsed(result);
      // Auto-match people: Deputy export code recorded before, then payroll id, then an exact name.
      const nextPeople: Record<string, string> = {};
      for (const person of result.people) {
        const byRef = staffRefs.find((ref) => ref.external_refs?.deputy_export_code === person.exportCode || ref.payroll_id === person.exportCode);
        const byName = byRef ? null : staff.find((member) => norm(member.name) === norm(person.cleanName));
        const match = byRef?.id ?? byName?.staffId;
        if (match && staff.some((member) => member.staffId === match)) nextPeople[person.exportCode] = match;
      }
      setPeopleMap(nextPeople);
      // Auto-match places: a work unit already tagged with this Deputy code, then an exact name.
      const nextPlaces: Record<string, PlaceAction> = {};
      for (const location of result.locations) {
        const unit = workUnits.find((candidate) => candidate.external_refs?.deputy?.code === location.code) ?? workUnits.find((candidate) => norm(candidate.name) === norm(location.name));
        nextPlaces[location.code] = unit ? { kind: 'match', workUnitId: unit.id } : locationGuidance(location.proposedType).canCreate ? { kind: 'create_internal' } : { kind: 'skip' };
      }
      setPlaceMap(nextPlaces);
      setStep(1);
    } catch (parseError) {
      setError(parseError instanceof Error ? parseError.message : 'The file could not be read.');
    } finally { setBusy(false); }
  };

  const review = useMemo(() => {
    if (!parsed) return null;
    const resolvedPlace = (code: string) => { const action = placeMap[code]; return Boolean(action && action.kind !== 'skip'); };
    const slotsReady = parsed.slots.filter((slot) => peopleMap[slot.exportCode] && resolvedPlace(slot.deputyCode));
    const slotsNoPerson = parsed.slots.filter((slot) => !peopleMap[slot.exportCode]).length;
    const slotsNoPlace = parsed.slots.filter((slot) => peopleMap[slot.exportCode] && !resolvedPlace(slot.deputyCode)).length;
    const leaveReady = parsed.leave.filter((item) => item.leaveType !== 'skip' && peopleMap[item.exportCode]);
    const leaveSkipped = parsed.leave.filter((item) => item.leaveType === 'skip').length;
    const leaveNoPerson = parsed.leave.filter((item) => item.leaveType !== 'skip' && !peopleMap[item.exportCode]).length;
    const placesCreate = parsed.locations.filter((location) => placeMap[location.code]?.kind === 'create_internal').length;
    const placesMatch = parsed.locations.filter((location) => placeMap[location.code]?.kind === 'match').length;
    const placesSkip = parsed.locations.length - placesCreate - placesMatch;
    const peopleMatched = parsed.people.filter((person) => peopleMap[person.exportCode]).length;
    const now = Date.now();
    const pastSlots = slotsReady.filter((slot) => new Date(slot.startsAt).getTime() < now).length;
    return { slotsReady, slotsNoPerson, slotsNoPlace, leaveReady, leaveSkipped, leaveNoPerson, placesCreate, placesMatch, placesSkip, peopleMatched, pastSlots };
  }, [parsed, peopleMap, placeMap]);

  const applyImport = async () => {
    if (!parsed || !review) return;
    setBusy(true); setError(null);
    // ATLAS WRITES: apply_deputy_roster_import (batch, work units, slot drafts, leave; audited)
    const { data, error: rpcError } = await supabase.rpc('apply_deputy_roster_import', {
      p_client_request_id: crypto.randomUUID(),
      p_operating_organization_id: operatingOrganizationId,
      p_source_file: mainFile?.name ?? 'deputy.csv',
      p_source_sha256: sourceHash,
      p_row_count: parsed.rows,
      p_locations: parsed.locations.map((location) => {
        const action = placeMap[location.code] ?? { kind: 'skip' };
        return { deputy_code: location.code, deputy_name: location.name, areas: location.areas, service_type: location.serviceType, action: action.kind, work_unit_id: action.kind === 'match' ? action.workUnitId : null };
      }),
      p_people: parsed.people.map((person) => ({ export_code: person.exportCode, staff_id: peopleMap[person.exportCode] ?? null })),
      p_slots: review.slotsReady.map((slot) => ({ key: slot.key, export_code: slot.exportCode, deputy_code: slot.deputyCode, deputy_name: slot.deputyName, starts_at: slot.startsAt, ends_at: slot.endsAt, notes: slot.notes, area_name: slot.areaName, area_code: slot.areaCode, pay_code: slot.payCode, ems_minutes: slot.emsMinutes, ncr_minutes: slot.ncrMinutes, purchase_order: slot.purchaseOrder, req_ritm: slot.reqRitm, warning: slot.warning, published: slot.published })),
      p_leave: review.leaveReady.map((item) => ({ key: item.key, export_code: item.exportCode, starts_on: item.startsOn, ends_on: item.endsOn, leave_type: item.leaveType, deputy_type: item.deputyType, hours: item.hours, status: item.status })),
      p_manifest: { source: 'deputy', rows: parsed.rows, people: parsed.people.length, locations: parsed.locations.length, schedule_rows: parsed.slots.length, timesheet_rows: parsed.timesheetRows, leave_rows: parsed.leave.length, parse_warnings: parsed.warnings.length },
    });
    if (rpcError || !data) setError(rpcError?.message ?? 'The import was not confirmed.');
    else { setReceipt(data as Receipt); await onImported?.(); }
    setBusy(false);
  };

  return (
    <div className="deputy-import-backdrop" role="presentation">
      <section className="deputy-import" role="dialog" aria-modal="true" aria-labelledby="deputy-import-title">
        <header>
          <div><span className="deputy-import-kicker">Roster import</span><h2 id="deputy-import-title">Import from Deputy</h2><p>Bring a Deputy export in as draft shifts and leave. Nothing is published, and no people are created.</p></div>
          <button type="button" className="deputy-import-close" onClick={onClose} aria-label="Close import">×</button>
        </header>
        <ol className="deputy-import-steps" aria-label="Import steps">
          {STEPS.map((label, index) => <li key={label} className={index < step ? 'is-done' : index === step ? 'is-current' : ''} aria-current={index === step ? 'step' : undefined}><span>{index + 1}</span>{label}</li>)}
        </ol>
        {error && <div className="deputy-import-message is-error" role="alert"><AlertTriangle size={16} />{error}</div>}

        {step === 0 && (
          <div className="deputy-import-body">
            <label className="deputy-import-file"><FileUp size={18} aria-hidden="true" /><div><strong>Deputy timesheet and schedule export</strong><small>The CSV with Display Name, Schedule Date, Location Name, Is Leave and the EMS / NCR / PO columns.</small>{mainFile && <em>{mainFile.name}</em>}</div><input type="file" accept=".csv,text/csv" aria-label="Deputy timesheet and schedule export" onChange={(event) => setMainFile(event.target.files?.[0] ?? null)} /></label>
            <label className="deputy-import-file"><MapPinned size={18} aria-hidden="true" /><div><strong>Deputy location and area export (optional)</strong><small>Adds places that had no shifts in the period so they can be mapped once.</small>{locationsFile && <em>{locationsFile.name}</em>}</div><input type="file" accept=".csv,text/csv" aria-label="Deputy location and area export" onChange={(event) => setLocationsFile(event.target.files?.[0] ?? null)} /></label>
            <p className="deputy-import-note">Files are read in your browser. Only matched people, places, schedules and leave are sent; dates of birth, contact details and pay are not.</p>
            <footer><button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" onClick={() => void readFiles()} disabled={busy || !mainFile}>{busy ? 'Reading…' : 'Read the files'}</button></footer>
          </div>
        )}

        {step === 1 && parsed && (
          <div className="deputy-import-body">
            <div className="deputy-import-summary"><span><strong>{parsed.rows}</strong> rows</span><span><strong>{parsed.people.length}</strong> people</span><span><strong>{parsed.locations.length}</strong> Deputy locations</span><span><strong>{parsed.slots.length}</strong> schedules</span><span><strong>{parsed.timesheetRows}</strong> timesheets</span><span><strong>{parsed.leave.length}</strong> leave</span></div>
            <p className="deputy-import-note"><Users size={14} aria-hidden="true" /> Match each Deputy person to someone already in your staff list. Nobody is created here — add missing people in People, Pay &amp; HR first, then import again.</p>
            <div className="deputy-import-table-wrap"><table className="deputy-import-table"><thead><tr><th>Deputy person</th><th>Export code</th><th>Schedules</th><th>Leave</th><th>Your staff member</th></tr></thead><tbody>
              {parsed.people.map((person) => <tr key={person.exportCode} className={peopleMap[person.exportCode] ? '' : 'is-unresolved'}><td>{person.cleanName}</td><td>{person.exportCode}</td><td>{person.scheduleRows}</td><td>{person.leaveRows}</td><td><select aria-label={`Staff member for ${person.cleanName}`} value={peopleMap[person.exportCode] ?? ''} onChange={(event) => setPeopleMap((current) => { const next = { ...current }; if (event.target.value) next[person.exportCode] = event.target.value; else delete next[person.exportCode]; return next; })}><option value="">Not in your staff list</option>{staff.map((member) => <option key={member.staffId} value={member.staffId}>{member.name}</option>)}</select></td></tr>)}
            </tbody></table></div>
            <footer><button type="button" className="btn btn-secondary" onClick={() => setStep(0)}>Back</button><button type="button" className="btn btn-primary" onClick={() => setStep(2)}>Next: places</button></footer>
          </div>
        )}

        {step === 2 && parsed && (
          <div className="deputy-import-body">
            <p className="deputy-import-note"><MapPinned size={14} aria-hidden="true" /> A Deputy location is something people get rostered onto. Pick the work unit it is here, or create it as internal work. Patrol runs and static posts come from client agreements, so they are picked, not created.</p>
            <div className="deputy-import-table-wrap"><table className="deputy-import-table"><thead><tr><th>Deputy location</th><th>Looks like</th><th>Schedules</th><th>What to do here</th></tr></thead><tbody>
              {parsed.locations.map((location) => {
                const guidance = locationGuidance(location.proposedType); const action = placeMap[location.code] ?? { kind: 'skip' };
                const value = action.kind === 'match' ? `match:${action.workUnitId}` : action.kind;
                return <tr key={location.code} className={action.kind === 'skip' ? 'is-unresolved' : ''}><td><strong>{location.name}</strong><small>{location.areas.join(', ') || 'No area'}{location.payCodes.length ? ` · ${location.payCodes.join('/')}` : ''}</small></td><td>{guidance.label}</td><td>{location.scheduleRows}</td><td>
                  <select aria-label={`Action for ${location.name}`} value={value} onChange={(event) => { const next = event.target.value; setPlaceMap((current) => ({ ...current, [location.code]: next.startsWith('match:') ? { kind: 'match', workUnitId: next.slice(6) } : next === 'create_internal' ? { kind: 'create_internal' } : { kind: 'skip' } })); }}>
                    <option value="skip">Skip for now</option>
                    {guidance.canCreate && <option value="create_internal">Create as internal work</option>}
                    <optgroup label="Use an existing work unit">{workUnits.map((unit) => <option key={unit.id} value={`match:${unit.id}`}>{unit.name} · {unit.work_unit_type === 'patrol' ? 'patrol run' : unit.work_unit_type === 'static' ? 'static post' : 'internal'}</option>)}</optgroup>
                  </select>
                  {action.kind === 'skip' && <small className="deputy-import-needs">{guidance.needs}</small>}
                </td></tr>;
              })}
            </tbody></table></div>
            <footer><button type="button" className="btn btn-secondary" onClick={() => setStep(1)}>Back</button><button type="button" className="btn btn-primary" onClick={() => setStep(3)}>Next: review</button></footer>
          </div>
        )}

        {step === 3 && parsed && review && !receipt && (
          <div className="deputy-import-body">
            <ul className="deputy-import-review">
              <li className={review.slotsReady.length ? 'is-ready' : ''}><strong>{review.slotsReady.length}</strong> draft shifts will be created{review.pastSlots ? ` (${review.pastSlots} are in the past and stay as history)` : ''}</li>
              {review.slotsNoPerson > 0 && <li className="is-warn"><strong>{review.slotsNoPerson}</strong> schedules skipped: person not in your staff list</li>}
              {review.slotsNoPlace > 0 && <li className="is-warn"><strong>{review.slotsNoPlace}</strong> schedules skipped: location skipped for now</li>}
              <li className={review.leaveReady.length ? 'is-ready' : ''}><strong>{review.leaveReady.length}</strong> leave records will be created{review.leaveSkipped ? ` (${review.leaveSkipped} offered-shift rows are not leave)` : ''}{review.leaveNoPerson ? ` · ${review.leaveNoPerson} skipped: person not matched` : ''}</li>
              <li><strong>{review.placesMatch}</strong> Deputy locations matched to work units · <strong>{review.placesCreate}</strong> created as internal work · <strong>{review.placesSkip}</strong> skipped</li>
              <li><strong>{review.peopleMatched}</strong> of {parsed.people.length} people matched. Nobody is created.</li>
              <li className="is-muted"><strong>{parsed.timesheetRows}</strong> timesheet rows are counted in the batch but not turned into pay or attendance records yet.</li>
              {parsed.warnings.length > 0 && <li className="is-warn"><strong>{parsed.warnings.length}</strong> rows could not be read: {parsed.warnings.slice(0, 2).join(' ')}{parsed.warnings.length > 2 ? ' …' : ''}</li>}
            </ul>
            <p className="deputy-import-note">Billing evidence on each shift (EMS minutes, NCR minutes, purchase order, REQ/RITM) is kept with the draft. Importing the same file again will not create duplicates.</p>
            <footer><button type="button" className="btn btn-secondary" onClick={() => setStep(2)}>Back</button><button type="button" className="btn btn-primary" onClick={() => void applyImport()} disabled={busy || (review.slotsReady.length === 0 && review.leaveReady.length === 0 && review.placesCreate === 0 && review.placesMatch === 0)}>{busy ? <><RefreshCw size={15} className="is-spinning" /> Importing…</> : `Import ${review.slotsReady.length} draft shifts and ${review.leaveReady.length} leave records`}</button></footer>
          </div>
        )}

        {receipt && (
          <div className="deputy-import-body">
            <div className="deputy-import-message is-success" role="status"><CheckCircle2 size={16} /><span><strong>Import recorded</strong> · batch {receipt.batch_id.slice(0, 8)}</span></div>
            <ul className="deputy-import-review">
              <li className="is-ready"><strong>{receipt.slots_created}</strong> draft shifts created{receipt.slots_already_imported ? ` · ${receipt.slots_already_imported} were already here` : ''}{receipt.slots_unresolved ? ` · ${receipt.slots_unresolved} could not be placed` : ''}</li>
              <li className="is-ready"><strong>{receipt.leave_created}</strong> leave records created{receipt.leave_already_imported ? ` · ${receipt.leave_already_imported} were already here` : ''}</li>
              <li><strong>{receipt.work_units_created}</strong> internal work units created · <strong>{receipt.work_units_matched}</strong> matched · <strong>{receipt.people_matched}</strong> people matched</li>
              <li className="is-muted"><strong>{receipt.timesheets_not_imported}</strong> timesheet rows kept in the batch for a later step</li>
            </ul>
            <p className="deputy-import-note">Next: the drafts are on the roster board. Check them, then publish so officers can accept.</p>
            <footer><button type="button" className="btn btn-primary" onClick={onClose}>Back to the roster</button></footer>
          </div>
        )}
      </section>
    </div>
  );
}
