/**
 * import-scv-csv — Canonical SCV CSV import
 *
 * Imports official/approved SCV CSV exports into canonical_scv.
 * This is the primary SCV lookup source for Freedom Camping. NZSCV API lookup
 * remains a later fallback/enrichment path.
 *
 * Auth: Supabase JWT required. User must be admin/master/grand_master.
 * Body: { file_name?: string, csv_text: string, organization_id?: string | null }
 */ import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
function normalisePlate(value) {
  return String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').trim();
}
function parseCsvLine(line) {
  const cells = [];
  let current = '';
  let inQuotes = false;
  for(let i = 0; i < line.length; i++){
    const char = line[i];
    const next = line[i + 1];
    if (char === '"' && inQuotes && next === '"') {
      current += '"';
      i++;
      continue;
    }
    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (char === ',' && !inQuotes) {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}
function parseCsv(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((line)=>line.trim());
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]).map((h)=>h.trim().toLowerCase().replace(/\s+/g, '_'));
  return lines.slice(1).map((line)=>{
    const cells = parseCsvLine(line);
    return Object.fromEntries(headers.map((header, index)=>[
        header,
        cells[index] ?? ''
      ]));
  });
}
function first(row, names) {
  for (const name of names){
    const key = name.toLowerCase().replace(/\s+/g, '_');
    if (row[key]) return row[key];
  }
  return '';
}
function parseDateOrNull(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  const nz = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (nz) {
    const [, d, m, y] = nz;
    const yyyy = y.length === 2 ? `20${y}` : y;
    return `${yyyy.padStart(4, '0')}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  return null;
}
function statusFromDates(rawStatus, expiry) {
  const status = rawStatus.toLowerCase().trim();
  // Direct canonical values.
  if ([
    'active',
    'expired',
    'suspended',
    'cancelled'
  ].includes(status)) return status;
  // Vendor synonyms seen in real SCV registers. 'current' = active (the
  // register uses "Current"). Map defensively for future files.
  if ([
    'current',
    'valid',
    'certified'
  ].includes(status)) return 'active';
  if ([
    'revoked',
    'withdrawn'
  ].includes(status)) return 'cancelled';
  if ([
    'lapsed'
  ].includes(status)) return 'expired';
  // No recognised status word -> fall back to expiry-date inference.
  if (expiry && expiry < new Date().toISOString().slice(0, 10)) return 'expired';
  return 'active';
}
// NZ self-containment certificates are valid for 4 YEARS from issue. The
// certifier's register supplies only the issue date (no expiry column), so we
// DERIVE expiry = issued + 4 years. Enforcement turns on "currently certified"
// (expiry_date >= today), so a derived expiry lets the compliance gate expire
// the cert on its own. Returns null if issued is null.
// LIMITATION: older 'blue' certs may carry a different printed expiry not
// derivable from issue date; only honourable when a richer register is supplied.
function deriveExpiryFromIssued(issued) {
  if (!issued) return null;
  const d = new Date(`${issued}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCFullYear(d.getUTCFullYear() + 4);
  return d.toISOString().slice(0, 10);
}
serve(async (req)=>{
  if (req.method === 'OPTIONS') return new Response('ok', {
    headers: CORS
  });
  const json = (body, status = 200)=>new Response(JSON.stringify(body), {
      status,
      headers: {
        ...CORS,
        'Content-Type': 'application/json'
      }
    });
  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({
      error: 'Unauthorized'
    }, 401);
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const token = authHeader.replace('Bearer ', '').trim();
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) return json({
      error: 'Unauthorized'
    }, 401);
    const { data: profile } = await supabase.from('user_profiles').select('id, role, organization_id').eq('id', user.id).single();
    const role = String(profile?.role ?? '');
    if (![
      'admin',
      'master',
      'grand_master'
    ].includes(role)) return json({
      error: 'Forbidden'
    }, 403);
    const body = await req.json();
    // Accept either csv_text (parse here) or a pre-parsed rows[] array.
    const rows = Array.isArray(body.rows) && body.rows.length > 0 ? body.rows : parseCsv(String(body.csv_text ?? ''));
    if (rows.length === 0) return json({
      error: 'csv_text or rows is required'
    }, 400);
    const orgId = body.organization_id ?? profile?.organization_id ?? null;
    const { data: batch, error: batchError } = await supabase.from('scv_import_batches').insert({
      organization_id: orgId,
      file_name: body.file_name ?? 'scv-import.csv',
      status: 'importing',
      total_rows: rows.length,
      imported_by: user.id,
      started_at: new Date().toISOString()
    }).select('id').single();
    if (batchError || !batch) throw new Error(batchError?.message ?? 'Could not create import batch');
    const batchId = batch.id;
    const nowIso = new Date().toISOString();
    // ── PHASE 1: transform every row in memory (NO DB calls here) ──────────
    // The old code did 3 awaited DB round-trips PER ROW (select + upsert +
    // insert) which 504'd on the 58k-row register. We now build all payloads
    // first, then bulk-write in chunks.
    const canonicalPayloads = [];
    const importRowPayloads = [];
    let validRows = 0, invalidRows = 0;
    const skippedRows = 0;
    // Guard against duplicate plates WITHIN the same file (a bulk upsert with
    // two rows sharing on_conflict key in one call errors). Owner ruling: keep
    // the row with the LATEST issued_date (the current cert), not just the last
    // row in file order. Track {index, issued} per plate to compare.
    const seenPlate = new Map();
    rows.forEach((row, index)=>{
      const plate = normalisePlate(first(row, [
        'plate',
        'plate_number',
        'registration',
        'rego',
        'vehicle_registration'
      ]));
      const certificateNumber = first(row, [
        'certificate_number',
        'certificate',
        'scv_number',
        'self_contained_certificate'
      ]);
      const issuedDate = parseDateOrNull(first(row, [
        'issued_date',
        'issue_date',
        'date_issued',
        'certificate_issue_date',
        'certificate_issue'
      ]));
      const sourceExpiry = parseDateOrNull(first(row, [
        'expiry_date',
        'expires',
        'valid_until',
        'certificate_expiry_date',
        'certificate_expiry'
      ]));
      const expiryDerived = !sourceExpiry && !!issuedDate;
      const expiryDate = sourceExpiry ?? deriveExpiryFromIssued(issuedDate);
      const status = statusFromDates(first(row, [
        'certificate_status',
        'status'
      ]), expiryDate);
      const vehicleYearRaw = first(row, [
        'vehicle_year',
        'year'
      ]);
      const vehicleYear = vehicleYearRaw ? Number.parseInt(vehicleYearRaw, 10) : null;
      if (!plate || plate.length < 2 || plate.length > 7) {
        invalidRows++;
        importRowPayloads.push({
          batch_id: batchId,
          row_number: index + 2,
          raw_row: row,
          normalized_plate: plate || null,
          row_status: 'invalid',
          error_message: 'Invalid or missing plate'
        });
        return;
      }
      const vehicleMake = first(row, [
        'vehicle_make',
        'make'
      ]) || null;
      const vehicleModel = first(row, [
        'vehicle_model',
        'model'
      ]) || null;
      const vehicleYearVal = Number.isFinite(vehicleYear) ? vehicleYear : null;
      const canonicalRow = {
        plate_number: plate,
        certificate_number: certificateNumber || null,
        certificate_status: status,
        issued_date: issuedDate,
        expiry_date: expiryDate,
        vehicle_make: vehicleMake,
        vehicle_model: vehicleModel,
        vehicle_year: vehicleYearVal,
        nzscv_raw: row,
        raw_source_row: expiryDerived ? {
          ...row,
          _expiry_derived: true,
          _expiry_rule: 'issued_date + 4 years (NZ SCV validity)'
        } : row,
        source: 'csv_import',
        import_batch_id: batchId,
        imported_at: nowIso,
        last_checked_at: nowIso,
        updated_at: nowIso
      };
      // De-dupe within the file: keep the row with the LATEST issued_date for a
      // plate (owner ruling). A dated cert always beats an undated one; equal or
      // both-null dates fall back to last-seen. Ensures on_conflict sees a single
      // row per plate per bulk call.
      const prev = seenPlate.get(plate);
      if (prev) {
        // Newer if this row has an issued date and (prev has none OR this >= prev).
        const isNewer = issuedDate !== null && (prev.issued === null || issuedDate >= prev.issued);
        if (isNewer) {
          canonicalPayloads[prev.idx] = canonicalRow;
          seenPlate.set(plate, {
            idx: prev.idx,
            issued: issuedDate
          });
        }
      // else keep the existing (later-or-equal-dated) payload; do not count twice.
      } else {
        seenPlate.set(plate, {
          idx: canonicalPayloads.length,
          issued: issuedDate
        });
        canonicalPayloads.push(canonicalRow);
        validRows++;
      }
      importRowPayloads.push({
        batch_id: batchId,
        row_number: index + 2,
        raw_row: row,
        normalized_plate: plate,
        certificate_number: certificateNumber || null,
        certificate_status: status,
        issued_date: issuedDate,
        expiry_date: expiryDate,
        vehicle_make: vehicleMake,
        vehicle_model: vehicleModel,
        vehicle_year: vehicleYearVal,
        row_status: 'inserted'
      });
    });
    // ── PHASE 2: bulk write in chunks ──────────────────────────────────────
    const CHUNK = 500;
    let upsertedRows = 0;
    const upsertErrors = [];
    for(let i = 0; i < canonicalPayloads.length; i += CHUNK){
      const slice = canonicalPayloads.slice(i, i + CHUNK);
      const { error: upErr } = await supabase.from('canonical_scv').upsert(slice, {
        onConflict: 'plate_number'
      });
      if (upErr) {
        upsertErrors.push(upErr.message);
      } else {
        upsertedRows += slice.length;
      }
    }
    // Audit rows (best-effort; failure here does not fail the import).
    for(let i = 0; i < importRowPayloads.length; i += CHUNK){
      await supabase.from('scv_import_rows').insert(importRowPayloads.slice(i, i + CHUNK));
    }
    const finalStatus = upsertErrors.length > 0 ? 'validated' : 'completed';
    await supabase.from('scv_import_batches').update({
      status: finalStatus,
      valid_rows: validRows,
      // NOTE: we no longer split inserted vs updated (the per-row existence
      // select that distinguished them was the 504 cause). Report combined
      // upserts under inserted_rows to keep the response contract stable.
      inserted_rows: upsertedRows,
      updated_rows: 0,
      skipped_rows: skippedRows,
      invalid_rows: invalidRows,
      error_summary: upsertErrors.length > 0 ? `${upsertErrors.length} chunk error(s): ${upsertErrors.slice(0, 3).join('; ')}`.slice(0, 1000) : invalidRows > 0 ? `${invalidRows} invalid rows require review` : null,
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }).eq('id', batchId);
    return json({
      batch_id: batchId,
      total_rows: rows.length,
      valid_rows: validRows,
      inserted_rows: upsertedRows,
      updated_rows: 0,
      skipped_rows: skippedRows,
      invalid_rows: invalidRows,
      status: finalStatus
    });
  } catch (err) {
    console.error('[import-scv-csv] error:', err);
    return json({
      error: 'SCV CSV import failed',
      detail: err instanceof Error ? err.message : String(err)
    }, 500);
  }
});
