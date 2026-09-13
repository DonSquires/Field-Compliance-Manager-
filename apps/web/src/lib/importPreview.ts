import readXlsxFile from 'read-excel-file/browser';

export interface ImportSchemaPreview {
  source_file: string;
  source_sha256?: string;
  parser: string;
  row_count: number;
  duplicate_count: number;
  malformed_row_count?: number;
  unresolved_count?: number;
  date_range: string;
  headers?: string[];
  sample_rows?: string[][];
  mappings: Array<{ source: string; target: string; confidence: string }>;
  warnings: string[];
}

export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const next = text[index + 1];
    if (character === '"' && quoted && next === '"') {
      cell += '"';
      index += 1;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === ',' && !quoted) {
      row.push(cell.trim());
      cell = '';
    } else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && next === '\n') index += 1;
      row.push(cell.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += character;
    }
  }
  if (cell || row.length) {
    row.push(cell.trim());
    if (row.some(Boolean)) rows.push(row);
  }
  return rows;
}

function mappingFor(headers: string[]): ImportSchemaPreview['mappings'] {
  const normalized = headers.map((header) => header.toLowerCase().replace(/[^a-z0-9]/g, ''));
  const mappings: ImportSchemaPreview['mappings'] = [];
  const add = (target: string, candidates: string[], confidence: string) => {
    const index = normalized.findIndex((header) => candidates.some((candidate) => header.includes(candidate)));
    if (index >= 0) mappings.push({ source: headers[index], target, confidence });
  };
  add('vehicle.registration', ['rego', 'registration', 'plate'], '99%');
  add('observation.observed_at', ['recordeddate', 'enteredtime', 'eventtime', 'date'], '96%');
  add('observation.site_name', ['title', 'site', 'location'], '91%');
  add('observation.driver', ['driver', 'officer', 'staff'], '87%');
  return mappings;
}

function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat('en-NZ', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(timestamp);
}

export function parseCsvPreview(text: string, fileName: string): ImportSchemaPreview {
  const rows = parseCsvRows(text);
  return buildPreview(rows, fileName, 'CSV / schema detection');
}

export function parseJsonPreview(text: string, fileName: string): ImportSchemaPreview {
  const parsed = JSON.parse(text) as unknown;
  const records = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { records?: unknown }).records)
      ? (parsed as { records: unknown[] }).records
      : parsed && typeof parsed === 'object' && Array.isArray((parsed as { jurisdictions?: unknown }).jurisdictions)
        ? (parsed as { jurisdictions: unknown[] }).jurisdictions
        : [parsed];
  const objectRecords = records.filter((record): record is Record<string, unknown> => Boolean(record && typeof record === 'object' && !Array.isArray(record)));
  if (objectRecords.length === 0) throw new Error('JSON must contain an object or an array of objects.');
  const headers = Array.from(new Set(objectRecords.flatMap((record) => Object.keys(record))));
  const rows = [headers, ...objectRecords.map((record) => headers.map((header) => {
    const value = record[header];
    return value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  }))];
  return buildPreview(rows, fileName, 'JSON / schema detection');
}

export function parseXlsxPreview(data: ArrayBuffer, fileName: string): Promise<ImportSchemaPreview> {
  return readXlsxFile(data).then((sheets) => {
    const sheet = sheets[0];
    if (!sheet) throw new Error('Workbook has no readable sheets.');
    return buildPreview(sheet.data.map((row) => row.map((value) => value instanceof Date ? value.toISOString() : String(value))), fileName, `XLSX / ${sheet.sheet} schema detection`);
  });
}

function buildPreview(rows: string[][], fileName: string, parser: string): ImportSchemaPreview {
  const headers = rows[0] ?? [];
  const records = rows.slice(1).filter((row) => row.some(Boolean));
  const malformedRowCount = records.filter((row) => row.length !== headers.length).length;
  const signatures = records.map((row) => row.join('\u001f'));
  const unique = new Set(signatures);
  const dates = records.flatMap((row) => row).filter((value) => /\d{4}[-/]\d{1,2}[-/\d]|\d{1,2}[-/]\d{1,2}[-/]\d{2,4}|T\d{2}:\d{2}/.test(value)).map((value) => Date.parse(value)).filter(Number.isFinite).sort((left, right) => left - right);
  const dateRange = dates.length > 1 ? `${formatDate(dates[0])} - ${formatDate(dates[dates.length - 1])}` : 'No date range detected';
  const mappings = mappingFor(headers);
  const warnings: string[] = [];
  const mappedIndexes = new Set(mappings.map((mapping) => headers.indexOf(mapping.source)));
  const unresolvedCount = records.filter((row) => row.length === headers.length && mappedIndexes.size > 0 && Array.from(mappedIndexes).some((index) => !row[index]?.trim())).length;
  if (unique.size !== records.length) warnings.push(`${records.length - unique.size} duplicate rows require review`);
  if (malformedRowCount > 0) warnings.push(`${malformedRowCount} malformed rows have a different column count`);
  if (unresolvedCount > 0) warnings.push(`${unresolvedCount} rows have unresolved mapped values`);
  if (!mappings.some((mapping) => mapping.target === 'vehicle.registration')) warnings.push('No vehicle registration column detected');
  if (!mappings.some((mapping) => mapping.target === 'observation.site_name')) warnings.push('No site or location column detected');
  warnings.push('Preview only: no canonical records will be written');
  return {
    source_file: fileName,
    parser,
    row_count: records.length,
    duplicate_count: records.length - unique.size,
    malformed_row_count: malformedRowCount,
    unresolved_count: unresolvedCount,
    date_range: dateRange,
    headers,
    sample_rows: records.slice(0, 5),
    mappings,
    warnings,
  };
}
