import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const url = Deno.env.get('SUPABASE_URL') ?? '';
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const json = (body: Record<string, unknown>, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

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
  const schema = await admin.rpc('bob_inspect_schema', { table_names: null });
  if (schema.error) return json({ error: `Live schema inspection failed: ${schema.error.message}` }, 500);
  const atlasTerms = ['patrol', 'site', 'zone', 'shift', 'dispatch', 'timesheet', 'finance'];
  const { data: capabilities } = await admin.from('bob_capability_map').select('entity_type,entity_name,present,wired,exercised,notes').eq('retirement_status', 'live').or(atlasTerms.map((term) => `entity_name.ilike.*${term}*`).join(',')) .limit(250);
  const { data: edges } = await admin.from('bob_app_map_edges').select('source_type,source_name,target_type,target_name,edge_kind,evidence_class').eq('retirement_status', 'live').or(atlasTerms.map((term) => `source_name.ilike.*${term}*,target_name.ilike.*${term}*`).join(',')) .limit(500);
  const plannerResponse = await fetch(`${url}/functions/v1/bob-plan-import`, { method: 'POST', headers: { Authorization: authHeader, 'Content-Type': 'application/json' }, body: JSON.stringify({ file_name: body.file_name ?? 'patrol-source.csv', document_text: csv, organization_id: profile.organization_id, max_candidates: body.max_candidates ?? 6, sample_size: body.sample_size ?? 25 }) });
  const plan = await plannerResponse.json().catch(() => ({}));
  return json({ planned: true, writes: [], organization_id: profile.organization_id, schema_tables: (schema.data?.tables ?? []).filter((table: { table: string }) => atlasTerms.some((term) => table.table.toLowerCase().includes(term))).map((table: { table: string; columns: unknown[] }) => ({ table: table.table, column_count: table.columns?.length ?? 0 })), atlas: { capabilities: capabilities ?? [], edges: edges ?? [] }, generic_plan: plan, notes: ['Read-only Atlas/schema-backed patrol planning. No sites, zones, routes, shifts, patrols, attendance, travel, or wages were written.', 'Human approval is required before any proposed mapping can reach bob-upsert-generic or a governed patrol promotion command.'] });
});
