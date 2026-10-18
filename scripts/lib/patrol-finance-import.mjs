import { createHash } from 'node:crypto';

const HEADER_ALIASES = {
  job: ['job', 'log no', 'logno'],
  patroller: ['patroller'],
  date: ['date'],
  time: ['time', '24hr time', 'time 24hrs'],
  reserve: ['reserve', 'code', 'forest', 'site'],
  location: ['location'],
  comments: ['comments', 'description/comments'],
  registration: ['reg', 'numbers', 'vehiclereg'],
  jobTime: ['job time', 'job time ncc', 'job time ofo', 'job time stringer', 'job time tpfl'],
  jobCost: ['job cost', 'job cost ncc', 'job cost ofo', 'job cost stringer', 'job cost tpfl'],
  jobKms: ['job kms', 'job km', 'job km ncc', 'job kms ncc', 'job km ofo', 'job km stringer', 'job km tpfl'],
  travelCost: ['travel cost', 'travel cost ncc', 'travel cost ofo', 'travel cost stringer', 'travel cost tpfl'],
  totalCost: ['total cost', 'total cost ncc', 'total cost ofo', 'total cost stringer', 'total cost tpfl'],
  chargeCode: ['charge code'],
  glCode: ['gl code'],
  glDescription: ['gl description'],
  type: ['type'],
  odo: ['odo', 'travel odo', 'travel odometer'],
  status: ['status'],
  dayOfWeek: ['dow', 'day of week'],
  source: ['source', 'source of information'],
  subject: ['subject'],
  issue: ['issue'],
  nztaCheck: ['nzta check', 'nzta checks', 'nzta'],
  nztaDate: ['nzta date'],
  actionBy: ['action by'],
  actionNotes: ['action / notes', 'action/notes', 'action', 'action notes', 'action taken or tbd'],
  actionDate: ['last action date', 'action date', 'actioned date'],
  closedBy: ['closed by', 'closed by.'],
  month: ['month'],
  year: ['year'],
  company: ['company'],
  zoneInitials: ['zone initials'],
  purchaseOrder: ['po num.', 'po number', 'purchase order'],
  area: ['area'],
  client: ['client'],
  contract: ['contract'],
  council: ['council'],
  vehicleDescription: ['desc; colour, make, model vehicle'],
  holdCategory: ['f/hold or cfl'],
  group: ['group'],
  itemCost: ['item cost'],
  itemTotal: ['item total'],
  name: ['name'],
  deerKilled: ['no. deer killed'],
  goatsKilled: ['no. goats killed'],
  otherKilled: ['no. other killed'],
  pigsKilled: ['no. pigs killed'],
  secondOfficerRate: ['2 man rate'],
  timeFraction: ['time as % of 24hrs'],
  auxiliary1: ['c1', 'n/a 2'],
  auxiliary2: ['c2', 'n/a2', 'n/a3'],
  auxiliary3: ['c3', 'n/a4', 'n/a5', 'n/a6', 'n/a7', 'n/a8'],
};

export function normalizeHeader(value) {
  return String(value ?? '').trim().toLowerCase().replace(/ #[0-9]+$/, '').replace(/\s+/g, ' ');
}

export function resolvePatrolColumns(headers) {
  const normalized = headers.map(normalizeHeader);
  return Object.fromEntries(Object.entries(HEADER_ALIASES).map(([field, aliases]) => [
    field,
    normalized.findIndex((header) => aliases.includes(header)),
  ]));
}

const PROFILE_TARGETS = {
  job: { target_entity: 'observations|location_events', target_field: 'external_ref' },
  patroller: { target_entity: 'observations|location_events', target_field: 'officer_id|observed_entity_id' },
  date: { target_entity: 'observations|location_events', target_field: 'observed_at|occurred_at' },
  time: { target_entity: 'observations|location_events', target_field: 'observed_at|occurred_at' },
  reserve: { target_entity: 'observations|location_events', target_field: 'zone_id' },
  location: { target_entity: 'observations|location_events', target_field: 'site_id|zone_id' },
  comments: { target_entity: 'observations|location_events', target_field: 'officer_notes|payload.comments' },
  registration: { target_entity: 'observations|location_events', target_field: 'plate_number|payload.reg_raw' },
  jobTime: { target_entity: 'observations|location_events', target_field: 'external_refs.import.job_time_hours|payload.job_time_hours' },
  jobKms: { target_entity: 'observations|location_events', target_field: 'distance_km' },
  source: { target_entity: 'observations|location_events', target_field: 'external_refs.import.source_category|payload.source_category' },
  subject: { target_entity: 'observations|location_events', target_field: 'external_refs.import.subject|payload.subject' },
  issue: { target_entity: 'observations|location_events', target_field: 'external_refs.import.issue|payload.issue' },
  actionBy: { target_entity: 'observations|location_events', target_field: 'external_refs.import.action_by|payload.action_by' },
  jobCost: { target_entity: 'file_import_row_proposals', target_field: 'source_values.job_cost' },
  travelCost: { target_entity: 'file_import_row_proposals', target_field: 'source_values.travel_cost' },
  totalCost: { target_entity: 'file_import_row_proposals', target_field: 'source_values.total_cost' },
  chargeCode: { target_entity: 'file_import_finance_cost_rows', target_field: 'source_values.charge_code|source_values.gl_code' },
  glCode: { target_entity: 'file_import_finance_cost_rows', target_field: 'source_values.charge_code|source_values.gl_code' },
  glDescription: { target_entity: 'file_import_finance_cost_rows', target_field: 'source_values.gl_description' },
  type: { target_entity: 'file_import_finance_cost_rows', target_field: 'source_values.activity_type' },
  odo: { target_entity: 'file_import_finance_cost_rows', target_field: 'source_values.odometer' },
  status: { target_entity: 'file_import_finance_cost_rows', target_field: 'source_values.status' },
  dayOfWeek: { target_entity: 'file_import_finance_cost_rows', target_field: 'source_values.day_of_week' },
  nztaCheck: { target_entity: 'file_import_finance_cost_rows', target_field: 'source_values.nzta_check' },
  nztaDate: { target_entity: 'file_import_finance_cost_rows', target_field: 'source_values.nzta_date' },
  actionNotes: { target_entity: 'file_import_finance_cost_rows', target_field: 'source_values.action_notes' },
  actionDate: { target_entity: 'file_import_finance_cost_rows', target_field: 'source_values.action_date' },
  closedBy: { target_entity: 'file_import_finance_cost_rows', target_field: 'source_values.closed_by' },
  month: { target_entity: 'file_import_finance_cost_rows', target_field: 'source_values.month' },
  year: { target_entity: 'file_import_finance_cost_rows', target_field: 'source_values.year' },
  company: { target_entity: 'file_import_finance_cost_rows', target_field: 'source_values.company' },
  zoneInitials: { target_entity: 'file_import_finance_cost_rows', target_field: 'source_values.zone_initials' },
  purchaseOrder: { target_entity: 'file_import_finance_cost_rows', target_field: 'source_values.purchase_order' },
  area: { target_entity: 'file_import_finance_cost_rows', target_field: 'source_values.area' },
  client: { target_entity: 'file_import_finance_cost_rows', target_field: 'source_values.client' },
  contract: { target_entity: 'file_import_finance_cost_rows', target_field: 'source_values.contract' },
  council: { target_entity: 'file_import_finance_cost_rows', target_field: 'source_values.council' },
  vehicleDescription: { target_entity: 'file_import_finance_cost_rows', target_field: 'source_values.vehicle_description' },
  holdCategory: { target_entity: 'file_import_finance_cost_rows', target_field: 'source_values.hold_category' },
  group: { target_entity: 'file_import_finance_cost_rows', target_field: 'source_values.group' },
  itemCost: { target_entity: 'file_import_finance_cost_rows', target_field: 'source_values.item_cost' },
  itemTotal: { target_entity: 'file_import_finance_cost_rows', target_field: 'source_values.item_total' },
  name: { target_entity: 'file_import_finance_cost_rows', target_field: 'source_values.name' },
  deerKilled: { target_entity: 'file_import_finance_cost_rows', target_field: 'source_values.deer_killed' },
  goatsKilled: { target_entity: 'file_import_finance_cost_rows', target_field: 'source_values.goats_killed' },
  otherKilled: { target_entity: 'file_import_finance_cost_rows', target_field: 'source_values.other_killed' },
  pigsKilled: { target_entity: 'file_import_finance_cost_rows', target_field: 'source_values.pigs_killed' },
  secondOfficerRate: { target_entity: 'file_import_finance_cost_rows', target_field: 'source_values.second_officer_rate' },
  timeFraction: { target_entity: 'file_import_finance_cost_rows', target_field: 'source_values.time_fraction' },
  auxiliary1: { target_entity: 'file_import_finance_cost_rows', target_field: 'source_values.auxiliary_1' },
  auxiliary2: { target_entity: 'file_import_finance_cost_rows', target_field: 'source_values.auxiliary_2' },
  auxiliary3: { target_entity: 'file_import_finance_cost_rows', target_field: 'source_values.auxiliary_3' },
};

export function resolveProfileMappings(headers) {
  return headers.filter((sourceColumn) => normalizeHeader(sourceColumn)).map((sourceColumn) => {
    const normalized = normalizeHeader(sourceColumn);
    const logicalField = Object.entries(HEADER_ALIASES)
      .find(([, aliases]) => aliases.includes(normalized))?.[0];
    const target = logicalField ? PROFILE_TARGETS[logicalField] : null;
    if (!target) throw new Error(`Unsupported patrol source column: ${sourceColumn}`);
    return { source_column: sourceColumn, ...target };
  });
}

export function parseFiniteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replaceAll(',', '').replace(/^\$/, '');
  if (!normalized || normalized.startsWith('#')) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseNzDate(value) {
  const validYear = (parsed) => parsed.getUTCFullYear() >= 2000 && parsed.getUTCFullYear() <= new Date().getUTCFullYear();
  if (value instanceof Date && !Number.isNaN(value.valueOf())) {
    return validYear(value) ? value.toISOString().slice(0, 10) : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const parsed = new Date((value - 25569) * 86400 * 1000);
    return Number.isNaN(parsed.valueOf()) || !validYear(parsed) ? null : parsed.toISOString().slice(0, 10);
  }
  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/.exec(String(value ?? '').trim());
  if (isoMatch) {
    const [, year, month, day] = isoMatch;
    const parsed = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
    if (
      parsed.getUTCFullYear() === Number(year)
      && parsed.getUTCMonth() === Number(month) - 1
      && parsed.getUTCDate() === Number(day)
      && validYear(parsed)
    ) return parsed.toISOString().slice(0, 10);
    return null;
  }
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(value ?? '').trim());
  if (!match) return null;
  const [, day, month, year] = match;
  const parsed = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (
    parsed.getUTCFullYear() !== Number(year)
    || parsed.getUTCMonth() !== Number(month) - 1
    || parsed.getUTCDate() !== Number(day)
  ) return null;
  return validYear(parsed) ? parsed.toISOString().slice(0, 10) : null;
}

function rowValue(row, columns, field) {
  const index = columns[field];
  return index >= 0 ? row.values[index] : null;
}

function formulaValue(row, columns, field) {
  const index = columns[field];
  if (index < 0) return null;
  if (Array.isArray(row.formulas)) {
    return row.formulas.find(([column]) => Number(column) === index + 1)?.[1] ?? null;
  }
  return row.formulas?.[String(index + 1)] ?? null;
}

function sourceRowHash(sourceFile, sourceSheet, sourceRow, row) {
  return createHash('sha256').update(JSON.stringify({
    source_file: sourceFile,
    source_sheet: sourceSheet,
    source_row: sourceRow,
    values: row.values,
    formulas: row.formulas ?? {},
  })).digest('hex');
}

function externalRef(clientCode, row, columns, serviceDate) {
  const job = String(rowValue(row, columns, 'job') ?? '').trim();
  if (job) return `rm_patrol_import:${clientCode}:${job}`;
  const fallback = [
    serviceDate,
    rowValue(row, columns, 'time'),
    rowValue(row, columns, 'location'),
    rowValue(row, columns, 'comments'),
  ].map((value) => String(value ?? '').trim()).join('|');
  return `rm_patrol_import:${clientCode}:${createHash('md5').update(fallback).digest('hex').slice(0, 8)}`;
}

export function buildPatrolFinanceRows({
  derivative,
  clientCode,
  providerOrganizationId,
  clientOrganizationId,
  serviceAgreementId,
  zoneMap,
}) {
  const columns = resolvePatrolColumns(derivative.headers);
  const rows = [];
  const summary = {
    source_rows: derivative.rows.length,
    component_rows: 0,
    eligible: 0,
    quarantined: 0,
    total_mismatches: 0,
    formula_errors: 0,
    unresolved_places: 0,
    invalid_dates: 0,
    duplicate_external_refs: 0,
    eligible_total: 0,
  };
  const seenExternalRefs = new Set();

  for (const row of derivative.rows) {
    const serviceDate = parseNzDate(rowValue(row, columns, 'date'));
    const reserve = String(rowValue(row, columns, 'reserve') ?? '').trim();
    const location = String(rowValue(row, columns, 'location') ?? '').trim();
    const place = (reserve && zoneMap[reserve]) ?? zoneMap[location] ?? null;
    const zoneId = typeof place === 'string' ? place : null;
    const siteId = place && typeof place === 'object' ? place.site_id ?? null : null;
    const reference = serviceDate ? externalRef(clientCode, row, columns, serviceDate) : null;
    const jobCostRaw = rowValue(row, columns, 'jobCost');
    const travelCostRaw = rowValue(row, columns, 'travelCost');
    const totalCostRaw = rowValue(row, columns, 'totalCost');
    const jobCost = parseFiniteNumber(jobCostRaw);
    const travelCost = parseFiniteNumber(travelCostRaw);
    const totalCost = parseFiniteNumber(totalCostRaw);
    const hasFormulaError = [jobCostRaw, travelCostRaw, totalCostRaw].some(
      (value) => typeof value === 'string' && value.trim().startsWith('#'),
    );
    const comparable = totalCost !== null && (jobCost !== null || travelCost !== null);
    const totalMismatch = comparable && Math.abs(totalCost - ((jobCost ?? 0) + (travelCost ?? 0))) > 0.02;
    const duplicateExternalRef = reference !== null && seenExternalRefs.has(reference);
    if (reference) seenExternalRefs.add(reference);

    let quarantineReason = null;
    if (!serviceDate) {
      quarantineReason = 'invalid_service_date';
      summary.invalid_dates += 1;
    } else if (!zoneId && !siteId) {
      quarantineReason = 'unresolved_contracted_place';
      summary.unresolved_places += 1;
    } else if (hasFormulaError) {
      quarantineReason = 'formula_error';
      summary.formula_errors += 1;
    } else if (totalMismatch) {
      quarantineReason = 'displayed_total_mismatch';
      summary.total_mismatches += 1;
    } else if (duplicateExternalRef) {
      quarantineReason = 'duplicate_external_reference';
      summary.duplicate_external_refs += 1;
    }

    const common = {
      organization_id: providerOrganizationId,
      client_organization_id: clientOrganizationId,
      service_agreement_id: serviceAgreementId,
      source_file: derivative.source_file,
      source_sha256: derivative.source_sha256,
      derivative_sha256: derivative.derivative_sha256,
      source_sheet: derivative.source_sheet,
      source_row: row.source_row,
      source_row_sha256: sourceRowHash(derivative.source_file, derivative.source_sheet, row.source_row, row),
      service_date: serviceDate,
      site_id: siteId,
      zone_id: zoneId,
      evidence_record_type: null,
      evidence_external_ref: reference,
      job_time: parseFiniteNumber(rowValue(row, columns, 'jobTime')),
      job_km: parseFiniteNumber(rowValue(row, columns, 'jobKms')),
      job_cost: jobCost,
      travel_cost: travelCost,
      total_cost: totalCost,
      charge_code: String(rowValue(row, columns, 'chargeCode') ?? '').trim() || null,
      gl_code: String(rowValue(row, columns, 'glCode') ?? '').trim() || null,
      gl_description: String(rowValue(row, columns, 'glDescription') ?? '').trim() || null,
      activity_type: String(rowValue(row, columns, 'type') ?? '').trim() || null,
      odometer: parseFiniteNumber(rowValue(row, columns, 'odo')),
      quarantine_reason: quarantineReason,
    };

    for (const [component, amount, costType, formula] of [
      ['job_cost', jobCost, 'labour', formulaValue(row, columns, 'jobCost')],
      ['travel_cost', travelCost, 'vehicle', formulaValue(row, columns, 'travelCost')],
    ]) {
      if (amount === null || amount <= 0) continue;
      const status = quarantineReason ? 'quarantined' : 'eligible';
      rows.push({
        ...common,
        component,
        cost_type: costType,
        amount: Math.round(amount * 100) / 100,
        formula,
        status,
        aggregate_key: serviceDate ? `${serviceDate.slice(0, 7)}:${component}` : null,
      });
      summary.component_rows += 1;
      summary[status] += 1;
      if (status === 'eligible') summary.eligible_total += Math.round(amount * 100) / 100;
    }
  }

  summary.eligible_total = Math.round(summary.eligible_total * 100) / 100;
  return { columns, rows, summary };
}
