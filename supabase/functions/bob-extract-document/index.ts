/**
 * bob-extract-document — document text/table extraction bridge
 *
 * Purpose:
 *   Turn uploaded documents into normalized text/table output Bob can read and
 *   route into ingest/compare/understanding. Unblocks XLSX -> table text for the
 *   governed importer and enables reading PDF/DOCX/CSV/TXT.
 *
 * Evidence-safe:
 *   - Never mutates the source file.
 *   - Returns checksum + basic provenance.
 *
 * Auth:
 *   Supabase JWT required. Caller must be admin/master/grand_master/admin_officer.
 */ import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import * as XLSX from 'https://esm.sh/xlsx@0.18.5';
import JSZip from 'https://esm.sh/jszip@3.10.1';
import { extractText as extractPdfTextContent, getDocumentProxy } from 'https://esm.sh/unpdf@0.12.1?target=deno';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};
const CAN_EXTRACT = new Set([
  'grand_master',
  'master',
  'admin',
  'admin_officer'
]);
const MAX_BYTES = 25 * 1024 * 1024;
const MAX_TEXT_CHARS = 200_000;
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS,
      'Content-Type': 'application/json'
    }
  });
}
function extLower(name) {
  const m = String(name ?? '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}
async function sha256(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map((b)=>b.toString(16).padStart(2, '0')).join('');
}
async function extractDocx(bytes) {
  try {
    const zip = await JSZip.loadAsync(bytes);
    const documentXml = zip.file('word/document.xml');
    if (!documentXml) return '';
    const xml = await documentXml.async('text');
    const document = new DOMParser().parseFromString(xml, 'application/xml');
    if (!document) return '';
    const textNodes = Array.from(document.getElementsByTagNameNS('http://schemas.openxmlformats.org/wordprocessingml/2006/main', 't'));
    return textNodes.map((node)=>node.textContent ?? '').join(' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT_CHARS);
  } catch  {
    return '';
  }
}
async function extractPdfText(bytes) {
  try {
    const document = await getDocumentProxy(bytes);
    const result = await extractPdfTextContent(document, { mergePages: true });
    return String(result.text ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT_CHARS);
  } catch (error) {
    console.error('[bob-extract-document] PDF text extraction failed:', error);
    return '';
  }
}
function extractXlsx(bytes) {
  const wb = XLSX.read(bytes, {
    type: 'array'
  });
  const sheetNames = wb.SheetNames ?? [];
  if (!sheetNames.length) return {
    table_text: '',
    sheet_names: [],
    selected_sheet: null
  };
  // Pick the first NON-EMPTY sheet. If every sheet is empty, fall back to the
  // first sheet (empty string). "Non-empty" = the CSV conversion has at least
  // one non-whitespace character beyond the header row. When multiple sheets
  // have content, prefer the one with the most rows so an instructional cover
  // sheet (1-2 rows) loses to the real data sheet.
  let bestCsv = '';
  let bestSheet = null;
  let bestRows = 0;
  for (const name of sheetNames){
    const ws = wb.Sheets[name];
    if (!ws) continue;
    const csv = XLSX.utils.sheet_to_csv(ws);
    const trimmed = csv.trim();
    if (!trimmed) continue;
    // Count non-empty lines as a proxy for row count.
    const rows = trimmed.split('\n').filter((l)=>l.trim()).length;
    if (rows > bestRows) {
      bestRows = rows;
      bestCsv = csv;
      bestSheet = name;
    }
  }
  // Fallback: if no sheet had content, use the first sheet's (empty) CSV.
  if (!bestSheet) {
    const ws = wb.Sheets[sheetNames[0]];
    bestCsv = ws ? XLSX.utils.sheet_to_csv(ws) : '';
    bestSheet = sheetNames[0];
  }
  return {
    table_text: bestCsv.slice(0, MAX_TEXT_CHARS),
    sheet_names: sheetNames,
    selected_sheet: bestSheet
  };
}
serve(async (req)=>{
  if (req.method === 'OPTIONS') return new Response('ok', {
    headers: CORS
  });
  if (req.method !== 'POST') return json({
    error: 'POST required'
  }, 405);
  try {
    const authHeader = req.headers.get('Authorization') ?? '';
    if (!authHeader) return json({
      error: 'Unauthorized'
    }, 401);
    const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: {
        headers: {
          Authorization: authHeader
        }
      }
    });
    const { data: { user }, error: authErr } = await callerClient.auth.getUser();
    if (authErr || !user) return json({
      error: 'Unauthorized'
    }, 401);
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: profile } = await admin.from('user_profiles').select('id, role').eq('id', user.id).single();
    if (!profile || !CAN_EXTRACT.has(String(profile.role))) {
      return json({
        error: 'Forbidden: admin/master/grand_master/admin_officer required'
      }, 403);
    }
    const body = await req.json();
    const fileName = String(body.file_name ?? body.storage_path ?? '').trim();
    if (!fileName) return json({
      error: 'file_name or storage_path is required'
    }, 400);
    let bytes;
    if (body.storage_bucket && body.storage_path) {
      const { data, error } = await admin.storage.from(body.storage_bucket).download(body.storage_path);
      if (error || !data) return json({
        error: `Could not download file: ${error?.message ?? 'not found'}`
      }, 404);
      bytes = new Uint8Array(await data.arrayBuffer());
    } else if (body.base64) {
      const clean = body.base64.replace(/^data:[^;]+;base64,/, '');
      const bin = atob(clean);
      bytes = new Uint8Array(bin.length);
      for(let i = 0; i < bin.length; i++)bytes[i] = bin.charCodeAt(i);
    } else {
      return json({
        error: 'Provide storage_bucket+storage_path or base64'
      }, 400);
    }
    if (bytes.byteLength > MAX_BYTES) return json({
      error: `File too large (${bytes.byteLength} bytes, max ${MAX_BYTES})`
    }, 413);
    const checksum = await sha256(bytes);
    const ext = extLower(fileName);
    let kind = 'unknown';
    let text = '';
    let tableText = '';
    let sheetNames;
    let selectedSheet;
    if (ext === 'csv' || ext === 'tsv' || ext === 'txt' || ext === 'md') {
      kind = 'text';
      text = new TextDecoder('utf-8', {
        fatal: false
      }).decode(bytes).slice(0, MAX_TEXT_CHARS);
      if (ext === 'csv' || ext === 'tsv') tableText = text;
    } else if (ext === 'xlsx' || ext === 'xls') {
      kind = 'spreadsheet';
      const out = extractXlsx(bytes);
      tableText = out.table_text;
      sheetNames = out.sheet_names;
      selectedSheet = out.selected_sheet;
      text = tableText;
    } else if (ext === 'pdf') {
      kind = 'pdf';
      text = await extractPdfText(bytes);
    } else if (ext === 'docx') {
      kind = 'docx';
      text = await extractDocx(bytes);
    } else {
      return json({
        error: `Unsupported document type '.${ext}' for text extraction`,
        kind: 'unsupported'
      }, 422);
    }
    const extracted = (tableText || text || '').trim();
    return json({
      success: true,
      kind,
      file_name: fileName,
      byte_size: bytes.byteLength,
      checksum,
      sheet_names: sheetNames,
      selected_sheet: selectedSheet,
      has_text: Boolean(extracted),
      text: text.slice(0, MAX_TEXT_CHARS),
      table_text: tableText.slice(0, MAX_TEXT_CHARS),
      note: extracted ? 'Text extracted. For scanned PDFs/images use OCR (later perception MR).' : 'No text extracted. This document may be scanned/image-based and needs OCR.',
      audit: {
        actor_id: user.id,
        role: profile.role
      }
    });
  } catch (err) {
    console.error('[bob-extract-document] error:', err);
    return json({
      error: 'Document extraction failed',
      detail: err instanceof Error ? err.message : String(err)
    }, 500);
  }
});
