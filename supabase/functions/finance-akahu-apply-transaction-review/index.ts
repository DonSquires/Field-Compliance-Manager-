import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const supabaseUrl = (Deno.env.get('SUPABASE_URL') ?? '').trim();
const anonKey = (Deno.env.get('SUPABASE_ANON_KEY') ?? '').trim();
const serviceKey = (Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '').trim();
const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const json = (body: Record<string, unknown>, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return json({ error: 'POST required' }, 405);
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
  const reportId = typeof body.report_id === 'string' ? body.report_id : '';
  const decision = body.decision === 'reject' ? 'rejected' : body.decision === 'approve' ? 'approved' : '';
  const transactions = Array.isArray(body.transactions) ? body.transactions : [];
  if (!reportId || !/^report_[a-z0-9]{24,27}$/.test(reportId)) return json({ error: 'A valid Apply report is required' }, 400);
  if (!decision || transactions.length < 1 || transactions.length > 100) return json({ error: 'Provide 1 to 100 transactions and an approve or reject decision' }, 400);

  const { data: localReport } = await admin.from('finance_akahu_apply_reports').select('id,status').eq('organization_id', profile.organization_id).eq('akahu_report_id', reportId).maybeSingle();
  if (!localReport) return json({ error: 'Apply report not found for this organisation' }, 404);
  if (localReport.status !== 'completed') return json({ error: 'Only completed Apply reports can be reviewed' }, 409);

  const rows = transactions.map((transaction: Record<string, unknown>) => ({
    organization_id: profile.organization_id,
    report_id: localReport.id,
    external_transaction_id: typeof transaction.id === 'string' ? transaction.id : typeof transaction._id === 'string' ? transaction._id : '',
    transaction_date: typeof transaction.date === 'string' ? transaction.date.slice(0, 10) : null,
    description: typeof transaction.description === 'string' ? transaction.description.slice(0, 500) : null,
    amount: typeof transaction.amount === 'number' ? transaction.amount : null,
    currency_code: typeof transaction.currency === 'string' ? transaction.currency : 'NZD',
    direction: transaction.action === 'money_in' ? 'credit' : transaction.action === 'money_out' ? 'debit' : 'unknown',
    raw_summary: transaction,
    review_status: decision,
    review_reason: typeof body.reason === 'string' ? body.reason.slice(0, 1000) : null,
    reviewed_by: user.id,
    reviewed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }));
  if (rows.some((row) => !row.external_transaction_id)) return json({ error: 'Every transaction must have a provider transaction identifier' }, 400);
  const { data: reviews, error: reviewError } = await admin.from('finance_akahu_apply_transaction_reviews').upsert(rows, { onConflict: 'report_id,external_transaction_id' }).select('id,external_transaction_id,review_status,reviewed_at');
  if (reviewError) return json({ error: 'Transaction review could not be recorded' }, 500);
  await admin.from('audit_log').insert({ organization_id: profile.organization_id, actor_user_id: user.id, action: decision === 'approved' ? 'finance_akahu_apply_transactions_approved' : 'finance_akahu_apply_transactions_rejected', target_table: 'finance_akahu_apply_transaction_reviews', target_id: localReport.id, metadata: { report_id: reportId, transaction_count: rows.length, promotion_required: true } });
  return json({ recorded: true, review_status: decision, transaction_count: reviews?.length ?? 0, reviews: reviews ?? [], promotion_required: true });
});
