/**
 * deputyImport.ts — parse a Deputy "Timesheets + Schedules + Leave" export (and the optional
 * Location/Area export) into what our roster understands, without touching the database.
 *
 * Deputy words -> ours: Location = rosterable work unit; Area = pay/roster bucket; Schedule =
 * planned shift (roster slot); Timesheet = actual (counted, not imported); Is Leave = leave.
 * Billing evidence (EMS Minutes, NCR Minutes, Purchase Order, REQ/RITM) travels with the slot.
 */

export interface DeputyLocation { code: string; name: string; areas: string[]; payCodes: string[]; scheduleRows: number; timesheetRows: number; proposedType: 'patrol' | 'static' | 'internal' | 'on_call'; serviceType: string }
export interface DeputyPerson { exportCode: string; displayName: string; cleanName: string; scheduleRows: number; timesheetRows: number; leaveRows: number }
export interface DeputySlot { key: string; exportCode: string; deputyCode: string; deputyName: string; startsAt: string; endsAt: string; notes: string | null; areaName: string | null; areaCode: string | null; payCode: string | null; emsMinutes: number | null; ncrMinutes: number | null; purchaseOrder: string | null; reqRitm: string | null; warning: string | null; published: boolean }
export interface DeputyLeave { key: string; exportCode: string; startsOn: string; endsOn: string; leaveType: 'annual' | 'sick' | 'bereavement' | 'parental' | 'unpaid' | 'other' | 'skip'; deputyType: string; hours: string | null; status: string }
export interface DeputyParseResult {
  rows: number; people: DeputyPerson[]; locations: DeputyLocation[]; slots: DeputySlot[]; leave: DeputyLeave[];
  timesheetRows: number; warnings: string[];
}

/** Minimal RFC 4180 reader: quoted fields, doubled quotes, embedded newlines. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let field = ''; let quoted = false;
  const src = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') { if (src[i + 1] === '"') { field += '"'; i += 1; } else quoted = false; }
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && src[i + 1] === '\n') i += 1; row.push(field); rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ''));
}

/** Deputy dates are d/m/yyyy and times h:mm in NZ local time. */
export function deputyDateTimeToIso(date: string, time: string): string | null {
  const d = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(date.trim()); const t = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!d || !t) return null;
  return `${d[3]}-${d[2].padStart(2, '0')}-${d[1].padStart(2, '0')}T${t[1].padStart(2, '0')}:${t[2]}:00+12:00`;
}
export function deputyDateToIsoDate(date: string): string | null {
  const d = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(date.trim());
  return d ? `${d[3]}-${d[2].padStart(2, '0')}-${d[1].padStart(2, '0')}` : null;
}

/** "(N)CAS - Dean Harvey [521735]" -> { name: "Dean Harvey", code: "521735" } */
export function splitDisplayName(display: string): { cleanName: string; exportCode: string | null } {
  const code = /\[(\d+)\]\s*$/.exec(display)?.[1] ?? null;
  const cleanName = display.replace(/\[\d+\]\s*$/, '').replace(/^\([A-Z]+\)\s*[A-Z]+\s*-\s*/, '').trim();
  return { cleanName, exportCode: code };
}

const PAY_CODE_TYPES: Record<string, DeputyLocation['proposedType']> = { MPP: 'patrol', SGC1: 'static', SGPWA: 'static', SGPSU: 'static', EMS: 'on_call', NSC: 'internal', OVH: 'internal', TRAIN: 'internal' };
export function proposeLocationType(name: string, payCodes: string[]): { type: DeputyLocation['proposedType']; serviceType: string } {
  const lower = name.toLowerCase();
  if (/\bems\b/.test(lower) || payCodes.includes('EMS')) return { type: 'on_call', serviceType: 'ems_on_call' };
  if (/patrol|\b58\d\b|\b59\d\b|\b62\d\b|\bncr\b|tasman|motueka/.test(lower) || payCodes.includes('MPP')) return { type: 'patrol', serviceType: 'patrol' };
  if (/office|rosterer|call centre|branch|6200-|nwp:/.test(lower) || payCodes.some((code) => ['NSC', 'OVH', 'TRAIN'].includes(code))) return { type: 'internal', serviceType: /rosterer|call centre/.test(lower) ? 'call_centre' : 'administration' };
  const byCode = payCodes.map((code) => PAY_CODE_TYPES[code]).find(Boolean);
  return byCode === 'static' || !byCode ? { type: 'static', serviceType: 'static_guarding' } : { type: byCode, serviceType: byCode === 'on_call' ? 'ems_on_call' : byCode };
}

export function mapLeaveType(deputyType: string): DeputyLeave['leaveType'] {
  const lower = deputyType.toLowerCase();
  if (/offered|dnu|please submit/.test(lower)) return 'skip';
  if (/annual|vacation|holiday taken|lieu/.test(lower)) return 'annual';
  if (/sick|carer/.test(lower)) return 'sick';
  if (/bereave/.test(lower)) return 'bereavement';
  if (/parental|maternity|paternity/.test(lower)) return 'parental';
  if (/lwop|without pay|unpaid/.test(lower)) return 'unpaid';
  return 'other';
}

/** Deterministic UUID (v5-shaped) from a stable key, so re-importing the same export never duplicates. */
export async function stableUuid(key: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`fcm-deputy:${key}`))).slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const REQUIRED = ['Display Name', 'Timesheet Date', 'Schedule Date', 'Schedule Start Time', 'Schedule End Time', 'Employee Export Code', 'Location Code', 'Location Name', 'Is Leave'];

export async function parseDeputyExport(text: string, locationsText?: string): Promise<DeputyParseResult> {
  const table = parseCsv(text);
  if (table.length < 2) throw new Error('The file has no data rows.');
  const header = table[0].map((h) => h.trim());
  const col = (name: string, occurrence = 0) => { let seen = -1; for (let i = 0; i < header.length; i += 1) { if (header[i] === name) { seen += 1; if (seen === occurrence) return i; } } return -1; };
  const missing = REQUIRED.filter((name) => col(name) < 0);
  if (missing.length) throw new Error(`This does not look like a Deputy timesheet/schedule export. Missing columns: ${missing.join(', ')}.`);
  const idx = {
    display: col('Display Name'), tsDate: col('Timesheet Date'), tsStart: col('Timesheet Start Time'), tsEnd: col('Timesheet End Time'),
    isLeave: col('Is Leave'), discarded: col('Discarded'), exportCode: col('Employee Export Code'),
    schDate: col('Schedule Date'), schStart: col('Schedule Start Time'), schEnd: col('Schedule End Time'), schNotes: col('Schedule Notes'), schWarning: col('Schedule Warning'), schPublished: col('Schedule Published'),
    areaName: col('Area Name'), areaCode: col('Area Export Code'), locCode: col('Location Code'), locName: col('Location Name', 0),
    leaveStart: col('Date Start'), leaveEnd: col('Date End'), leaveType: col('Leave Type Name'), leaveStatus: col('Leave Status'), leaveHours: col('Total Hours'),
    reqRitm: col('REQ / RITM Number'), po: col('Purchase Order'), ems: col('EMS Minutes'), ncr: col('NCR Minutes'),
  };
  const cell = (row: string[], i: number) => (i >= 0 ? (row[i] ?? '').trim() : '');
  const people = new Map<string, DeputyPerson>(); const locations = new Map<string, DeputyLocation & { payCodeSet: Set<string>; areaSet: Set<string> }>();
  const slots: DeputySlot[] = []; const leave: DeputyLeave[] = []; const warnings: string[] = []; let timesheetRows = 0;

  for (const row of table.slice(1)) {
    const display = cell(row, idx.display); const { cleanName, exportCode: codeFromName } = splitDisplayName(display);
    const exportCode = cell(row, idx.exportCode) || codeFromName || '';
    if (!exportCode) { warnings.push(`Row for "${cleanName || display}" has no employee export code and was skipped.`); continue; }
    const person = people.get(exportCode) ?? { exportCode, displayName: display, cleanName: cleanName || display, scheduleRows: 0, timesheetRows: 0, leaveRows: 0 };
    people.set(exportCode, person);
    const isLeave = cell(row, idx.isLeave).toUpperCase() === 'TRUE';
    const locCode = cell(row, idx.locCode); const locName = cell(row, idx.locName);
    const areaName = cell(row, idx.areaName); const areaCode = cell(row, idx.areaCode); const payCode = areaCode.includes('|') ? areaCode.split('|').pop()! : '';
    if (locName) {
      const key = locCode || locName;
      const loc = locations.get(key) ?? { code: locCode || locName, name: locName, areas: [], payCodes: [], scheduleRows: 0, timesheetRows: 0, proposedType: 'static', serviceType: 'static_guarding', payCodeSet: new Set<string>(), areaSet: new Set<string>() };
      if (areaName) loc.areaSet.add(areaName); if (payCode) loc.payCodeSet.add(payCode);
      locations.set(key, loc);
      if (cell(row, idx.tsDate)) loc.timesheetRows += 1;
      if (cell(row, idx.schDate)) loc.scheduleRows += 1;
    }
    if (isLeave) {
      person.leaveRows += 1;
      const startsOn = deputyDateToIsoDate(cell(row, idx.leaveStart) || cell(row, idx.tsDate)); const endsOn = deputyDateToIsoDate(cell(row, idx.leaveEnd) || cell(row, idx.tsDate));
      const deputyType = cell(row, idx.leaveType) || 'Leave';
      if (startsOn && endsOn) leave.push({ key: await stableUuid(`leave|${exportCode}|${startsOn}|${endsOn}|${deputyType}`), exportCode, startsOn, endsOn, leaveType: mapLeaveType(deputyType), deputyType, hours: cell(row, idx.leaveHours) || null, status: cell(row, idx.leaveStatus) || 'Unknown' });
      continue;
    }
    if (cell(row, idx.tsDate)) { timesheetRows += 1; person.timesheetRows += 1; }
    if (cell(row, idx.schDate) && cell(row, idx.discarded).toUpperCase() !== 'TRUE') {
      const startsAt = deputyDateTimeToIso(cell(row, idx.schDate), cell(row, idx.schStart)); let endsAt = deputyDateTimeToIso(cell(row, idx.schDate), cell(row, idx.schEnd));
      if (startsAt && endsAt && endsAt <= startsAt) { const end = new Date(endsAt); end.setUTCDate(end.getUTCDate() + 1); endsAt = end.toISOString(); }
      if (!startsAt || !endsAt || !locName) { warnings.push(`Schedule for ${person.cleanName} on ${cell(row, idx.schDate)} is missing a time or a location and was skipped.`); continue; }
      person.scheduleRows += 1;
      const emsMinutes = Number.parseInt(cell(row, idx.ems), 10); const ncrMinutes = Number.parseInt(cell(row, idx.ncr), 10);
      const cleanRef = (value: string) => (value && !/^na$/i.test(value) ? value : null);
      slots.push({
        key: await stableUuid(`schedule|${exportCode}|${startsAt}|${locCode || locName}`), exportCode, deputyCode: locCode || locName, deputyName: locName, startsAt, endsAt,
        notes: cell(row, idx.schNotes) || null, areaName: areaName || null, areaCode: areaCode || null, payCode: payCode || null,
        emsMinutes: Number.isFinite(emsMinutes) ? emsMinutes : null, ncrMinutes: Number.isFinite(ncrMinutes) ? ncrMinutes : null,
        purchaseOrder: cleanRef(cell(row, idx.po)), reqRitm: cleanRef(cell(row, idx.reqRitm)), warning: cell(row, idx.schWarning) || null,
        published: cell(row, idx.schPublished).toUpperCase() === 'TRUE',
      });
    }
  }

  if (locationsText) {
    // The Location/Area export lists places that had no rows in the period; add them so they can be mapped once.
    const locTable = parseCsv(locationsText); const locHeader = locTable[0]?.map((h) => h.trim()) ?? [];
    const lCode = locHeader.indexOf('Location Code'); const lName = locHeader.indexOf('Location Name'); const lArea = locHeader.indexOf('Area Name'); const lAreaCode = locHeader.indexOf('Area Export Code');
    if (lCode >= 0 && lName >= 0) for (const row of locTable.slice(1)) {
      const code = (row[lCode] ?? '').trim(); const name = (row[lName] ?? '').trim(); if (!name) continue;
      const key = code || name;
      const loc = locations.get(key) ?? { code: code || name, name, areas: [], payCodes: [], scheduleRows: 0, timesheetRows: 0, proposedType: 'static', serviceType: 'static_guarding', payCodeSet: new Set<string>(), areaSet: new Set<string>() };
      const area = (row[lArea] ?? '').trim(); const areaCode = (row[lAreaCode] ?? '').trim(); const payCode = areaCode.includes('|') ? areaCode.split('|').pop()! : '';
      if (area) loc.areaSet.add(area); if (payCode) loc.payCodeSet.add(payCode);
      locations.set(key, loc);
    }
  }

  const locationList: DeputyLocation[] = [...locations.values()].map((loc) => {
    const payCodes = [...loc.payCodeSet].sort(); const proposal = proposeLocationType(loc.name, payCodes);
    return { code: loc.code, name: loc.name, areas: [...loc.areaSet].sort(), payCodes, scheduleRows: loc.scheduleRows, timesheetRows: loc.timesheetRows, proposedType: proposal.type, serviceType: proposal.serviceType };
  }).sort((a, b) => b.scheduleRows - a.scheduleRows || a.name.localeCompare(b.name));

  return { rows: table.length - 1, people: [...people.values()].sort((a, b) => a.cleanName.localeCompare(b.cleanName)), locations: locationList, slots, leave, timesheetRows, warnings };
}

/** Plain-words explanation of what a Deputy location can become here, and what it needs first. */
export function locationGuidance(type: DeputyLocation['proposedType']): { label: string; canCreate: boolean; needs: string } {
  switch (type) {
    case 'patrol': return { label: 'Patrol run', canCreate: false, needs: 'Patrol runs come from a client agreement. Build the run in Client Portfolios, then pick it here.' };
    case 'static': return { label: 'Static post', canCreate: false, needs: 'Static posts need the client agreement place and its Static Guarding module. Set that up in Client Portfolios, then pick the work unit here.' };
    case 'on_call': return { label: 'On-call / EMS', canCreate: true, needs: 'Created as internal on-call work at a workplace named after the Deputy location.' };
    default: return { label: 'Office / internal', canCreate: true, needs: 'Created as internal work at a workplace named after the Deputy location.' };
  }
}
