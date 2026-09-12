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
  const connectionRequestId = typeof body.connection_request_id === 'string' ? body.connection_request_id : '';
  const reviewIds = Array.isArray(body.review_ids) ? body.review_ids.filter((value: unknown): value is string => typeof value === 'string') : [];
  if (!connectionRequestId || reviewIds.length < 1 || reviewIds.length > 100) return json({ error: 'A connection request and 1 to 100 review rows are required' }, 400);

  const { data: connection } = await admin.from('finance_external_connection_requests').select('id,organization_id,provider_type,status,bank_account_id').eq('id', connectionRequestId).eq('organization_id', profile.organization_id).maybeSingle();
  if (!connection || connection.provider_type !== 'bank' || !connection.bank_account_id) return json({ error: 'A bank connection request from this organisation is required' }, 400);
  if (!['connected', 'needs_review'].includes(connection.status)) return json({ error: 'The target bank connection is not ready for promotion' }, 409);

  const { data: reviews } = await admin.from('finance_akahu_apply_transaction_reviews').select('id,report_id,external_transaction_id,transaction_date,description,amount,currency_code,direction,raw_summary,review_status').eq('organization_id', profile.organization_id).in('id', reviewIds);
  if (!reviews || reviews.length !== reviewIds.length) return json({ error: 'One or more review rows are outside this organisation or missing' }, 404);
  if (reviews.some((review) => review.review_status !== 'approved')) return json({ error: 'Only approved Apply review rows can be promoted' }, 409);

  const rows = reviews.map((review) => ({ organization_id: profile.organization_id, connection_request_id: connection.id, bank_account_id: connection.bank_account_id, external_transaction_id: `akahu_apply:${review.report_id}:${review.external_transaction_id}`, transaction_date: review.transaction_date, description: review.description, amount: review.amount, currency_code: review.currency_code, direction: review.direction, raw_summary: { source: 'akahu_apply', apply_review_id: review.id, report_id: review.report_id, provider_transaction_id: review.external_transaction_id, data: review.raw_summary }, reconciliation_status: 'review' }));
  const { data: promoted, error: promotionError } = await admin.from('finance_external_bank_transactions').upsert(rows, { onConflict: 'connection_request_id,external_transaction_id' }).select('id,external_transaction_id,reconciliation_status');
  if (promotionError) return json({ error: 'Approved Apply transactions could not be promoted' }, 500);
  await admin.from('audit_log').insert({ organization_id: profile.organization_id, actor_user_id: user.id, action: 'finance_akahu_apply_transactions_promoted', target_table: 'finance_external_bank_transactions', target_id: connection.id, metadata: { connection_request_id: connection.id, review_count: reviews.length, promoted_count: promoted?.length ?? 0, reconciliation_status: 'review' } });
  return json({ promoted: true, promoted_count: promoted?.length ?? 0, reconciliation_status: 'review', payment_matching_required: true });
});
