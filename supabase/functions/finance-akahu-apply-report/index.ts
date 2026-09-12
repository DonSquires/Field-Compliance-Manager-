import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const supabaseUrl = (Deno.env.get('SUPABASE_URL') ?? '').trim();
const anonKey = (Deno.env.get('SUPABASE_ANON_KEY') ?? '').trim();
const serviceKey = (Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '').trim();
const applyApiKey = (Deno.env.get('AKAHU_APPLY_API_KEY') ?? '').trim();
const applyBase = 'https://api.apply.akahu.nz/v1';
const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const json = (body: Record<string, unknown>, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
const reportPattern = /^report_[a-z0-9]{24,27}$/;
const applicationPattern = /^application_[a-z0-9]{24,27}$/;
const documentPattern = /^doc_[a-z0-9]{24,27}$/;

serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return json({ error: 'POST required' }, 405);
  if (!applyApiKey) return json({ error: 'Akahu Apply is not configured yet' }, 503);

  const authorization = request.headers.get('Authorization');
  if (!authorization) return json({ error: 'Authentication required' }, 401);
  const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authorization } } });
  const { data: { user }, error: userError } = await userClient.auth.getUser();
  if (userError || !user) return json({ error: 'Authentication required' }, 401);

  const admin = createClient(supabaseUrl, serviceKey);
  const { data: profile } = await admin.from('user_profiles').select('organization_id,role,deactivated_at').eq('id', user.id).maybeSingle();
  if (!profile?.organization_id || profile.deactivated_at) return json({ error: 'Active organisation profile required' }, 403);
  if (!['grand_master', 'master', 'admin', 'admin_officer'].includes(profile.role)) return json({ error: 'Finance administrator required' }, 403);

  const body = await request.json().catch(() => ({}));
  const action = body.action === 'status' ? 'status' : 'create';
  const wantsData = body.action === 'data';
  const applicationId = typeof body.application_id === 'string' ? body.application_id : '';
  if (!applicationId || !applicationPattern.test(applicationId)) return json({ error: 'A valid Apply application is required' }, 400);
  const { data: application } = await admin.from('finance_akahu_apply_applications').select('id,akahu_application_id').eq('id', applicationId).eq('organization_id', profile.organization_id).maybeSingle();
  if (!application) return json({ error: 'Apply application not found for this organisation' }, 404);

  let reportId = typeof body.report_id === 'string' ? body.report_id : '';
  if ((action === 'status' || wantsData) && !reportPattern.test(reportId)) return json({ error: 'A valid Apply report is required' }, 400);
  if (action === 'create') {
    const documentIds = Array.isArray(body.document_ids) ? body.document_ids.filter((value: unknown): value is string => typeof value === 'string') : [];
    if (documentIds.some((value: string) => !documentPattern.test(value))) return json({ error: 'document_ids contains an invalid document' }, 400);
    const response = await fetch(`${applyBase}/applications/${application.akahu_application_id}/reports`, { method: 'POST', headers: { Authorization: `Bearer ${applyApiKey}`, Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(documentIds.length ? { _documents: documentIds } : {}) });
    if (!response.ok) return json({ error: 'Akahu Apply could not create the report', upstream_status: response.status }, 502);
    const payload = await response.json();
    reportId = typeof payload._id === 'string' ? payload._id : '';
    if (!reportPattern.test(reportId)) return json({ error: 'Akahu Apply returned an invalid report identifier' }, 502);
    const { data: report, error: insertError } = await admin.from('finance_akahu_apply_reports').insert({ organization_id: profile.organization_id, application_id: application.id, akahu_report_id: reportId, status: payload.status ?? 'pending', source_document_ids: documentIds, created_by: user.id }).select('id,application_id,akahu_report_id,status,source_document_ids,result_summary,created_at,updated_at,completed_at').single();
    if (insertError) return json({ error: 'Apply report was created but could not be recorded locally' }, 500);
    await admin.from('audit_log').insert({ organization_id: profile.organization_id, actor_user_id: user.id, action: 'finance_akahu_apply_report_created', target_table: 'finance_akahu_apply_reports', target_id: report.id, metadata: { application_id: application.id, akahu_report_id: reportId, document_count: documentIds.length } });
    return json({ created: true, report });
  }

  const { data: localReport } = await admin.from('finance_akahu_apply_reports').select('id,application_id,akahu_report_id,status,source_document_ids,result_summary,created_at,updated_at,completed_at').eq('application_id', application.id).eq('akahu_report_id', reportId).eq('organization_id', profile.organization_id).maybeSingle();
  if (!localReport) return json({ error: 'Apply report not found for this organisation' }, 404);
  if (wantsData) {
    if (localReport.status !== 'completed') return json({ error: 'Apply report is not ready for review', status: localReport.status }, 409);
    const response = await fetch(`${applyBase}/applications/${application.akahu_application_id}/reports/${reportId}/json`, { headers: { Authorization: `Bearer ${applyApiKey}`, Accept: 'application/json' } });
    if (!response.ok) return json({ error: 'Akahu Apply report data could not be retrieved', upstream_status: response.status }, 502);
    const payload = await response.json();
    const transactions = Array.isArray(payload.transactions) ? payload.transactions : [];
    const insights = Array.isArray(payload.insights) ? payload.insights : [];
    const accounts = Array.isArray(payload.accounts) ? payload.accounts : [];
    const dataSources = Array.isArray(payload.data_sources) ? payload.data_sources : [];
    const reviewSummary = { account_count: accounts.length, data_source_count: dataSources.length, transaction_count: transactions.length, insight_count: insights.length, transaction_total: transactions.reduce((total: number, transaction: Record<string, unknown>) => total + (typeof transaction.amount === 'number' ? transaction.amount : 0), 0), transactions: transactions.slice(0, 50), insights: insights.slice(0, 50), truncated: transactions.length > 50 || insights.length > 50 };
    await admin.from('audit_log').insert({ organization_id: profile.organization_id, actor_user_id: user.id, action: 'finance_akahu_apply_report_reviewed', target_table: 'finance_akahu_apply_reports', target_id: localReport.id, metadata: { account_count: accounts.length, data_source_count: dataSources.length, transaction_count: transactions.length, insight_count: insights.length } });
    return json({ created: false, report: localReport, review_summary: reviewSummary });
  }
  const response = await fetch(`${applyBase}/applications/${application.akahu_application_id}/reports/${reportId}`, { headers: { Authorization: `Bearer ${applyApiKey}`, Accept: 'application/json' } });
  if (!response.ok) return json({ error: 'Akahu Apply report status could not be retrieved', upstream_status: response.status }, 502);
  const payload = await response.json();
  const status = ['pending', 'processing', 'completed', 'failed'].includes(payload.status) ? payload.status : localReport.status;
  const resultSummary = { status, updated_at: payload.updated_at ?? null, completed_at: payload.completed_at ?? null };
  const { data: report, error: updateError } = await admin.from('finance_akahu_apply_reports').update({ status, failure_reason: payload.failure_reason ?? null, result_summary: resultSummary, completed_at: status === 'completed' ? (payload.completed_at ?? new Date().toISOString()) : null, updated_at: new Date().toISOString() }).eq('id', localReport.id).eq('organization_id', profile.organization_id).select('id,application_id,akahu_report_id,status,source_document_ids,result_summary,created_at,updated_at,completed_at').single();
  if (updateError) return json({ error: 'Apply report status could not be recorded locally' }, 500);
  await admin.from('audit_log').insert({ organization_id: profile.organization_id, actor_user_id: user.id, action: 'finance_akahu_apply_report_status_checked', target_table: 'finance_akahu_apply_reports', target_id: localReport.id, metadata: { status } });
  return json({ created: false, report });
});
