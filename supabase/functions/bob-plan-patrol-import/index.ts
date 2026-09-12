import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const url = Deno.env.get('SUPABASE_URL') ?? '';
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const json = (body: Record<string, unknown>, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const normalize = (value: unknown) => String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const parseLine = (line: string) => { const cells: string[] = []; let current = ''; let quoted = false; for (let i = 0; i < line.length; i += 1) { const char = line[i]; const next = line[i + 1]; if (char === '"' && quoted && next === '"') { current += '"'; i += 1; continue; } if (char === '"') { quoted = !quoted; continue; } if (char === ',' && !quoted) { cells.push(current.trim()); current = ''; continue; } current += char; } cells.push(current.trim()); return cells; };
const parseCsv = (text: string) => { const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.trim()); const headerIndex = lines.findIndex((line) => parseLine(line).length > 3); if (headerIndex < 0) return { headers: [], rows: [] as Record<string, string>[] }; const headers = parseLine(lines[headerIndex]); const rows = lines.slice(headerIndex + 1).map((line) => { const cells = parseLine(line); return Object.fromEntries(headers.map((header, index) => [header.trim(), cells[index] ?? ''])); }).filter((row) => Object.values(row).some((value) => String(value).trim())); return { headers, rows }; };

serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (request.method !== 'POST') return json({ error: 'POST required' }, 405);
  const authHeader = request.headers.get('Authorization');
  if (!authHeader) return json({ error: 'Authentication required' }, 401);
  const caller = createClient(url, anonKey, { global: { headers: { Authorization: authHeader } } });
  const { data: { user }, error: authError } = await caller.auth.getUser();
  if (authError || !user) return json({ error: 'Authentication required' }, 401);
  const admin = createClient(url, serviceKey);
  const { data: profile } = await admin.from('user_profiles').select('organization_id,role,deactivated_at').eq('id', user.id).maybeSingle();
  if (!profile?.organization_id || profile.deactivated_at || !['grand_master', 'master', 'admin', 'admin_officer'].includes(profile.role)) return json({ error: 'Finance/operations administrator required' }, 403);
  const body = await request.json().catch(() => ({}));
  let csv = typeof body.csv_text === 'string' ? body.csv_text : '';
  if (body.attachment_id) {
    const { data: attachment } = await admin.from('bob_attachments').select('organization_id,storage_bucket,storage_path,file_name').eq('id', body.attachment_id).eq('organization_id', profile.organization_id).maybeSingle();
    if (!attachment) return json({ error: 'Patrol attachment not found in organisation' }, 404);
    const { data, error } = await admin.storage.from(attachment.storage_bucket).download(attachment.storage_path);
    if (error || !data) return json({ error: 'Patrol source could not be downloaded' }, 404);
    csv = await data.text();
  }
  if (!csv.trim()) return json({ error: 'csv_text or attachment_id is required' }, 400);
  const parsed = parseCsv(csv);
  const rows = parsed.rows;
  const clientNames = [...new Set(rows.map((row) => row['Client Name']).filter(Boolean))];
  const clientRefs = [...new Set(rows.map((row) => row['Client ID']).filter(Boolean))];
  const despatchZones = [...new Set(rows.map((row) => row['Despatch Zone']).filter(Boolean))];
  const { data: sites } = await admin.from('client_sites').select('id,name,address,external_ref,internal_client_ref,client_organization_id,service_agreement_id').eq('organization_id', profile.organization_id).limit(1000);
  const { data: agreements } = await admin.from('service_agreements').select('id,name,client_organization_id').eq('provider_organization_id', profile.organization_id).eq('invitation_status', 'accepted').limit(500);
  const siteRows = sites ?? [];
  const matchSite = (name: string, ref: string) => siteRows.find((site) => site.external_ref === ref || site.internal_client_ref === ref || normalize(site.name) === normalize(name) || normalize(site.address) === normalize(name));
  const matches = clientNames.map((name) => { const ref = rows.find((row) => row['Client Name'] === name)?.['Client ID'] ?? ''; const site = matchSite(name, ref); return { source_name: name, source_ref: ref, candidate_site_id: site?.id ?? null, candidate_site_name: site?.name ?? null, match_kind: site ? (site.external_ref === ref || site.internal_client_ref === ref ? 'external_ref' : 'name_or_address') : 'unresolved' }; });
  return json({ planned: true, writes: [], organization_id: profile.organization_id, row_count: rows.length, client_name_count: clientNames.length, client_ref_count: clientRefs.length, despatch_zone_count: despatchZones.length, matches, unresolved_count: matches.filter((match) => !match.candidate_site_id).length, notes: ['Read-only patrol mapping plan. No sites, zones, routes, shifts, patrols, attendance, travel, or wages were written.', 'Patrol outcome rows require an approved site/agreement/shift attribution before promotion.'] });
});
