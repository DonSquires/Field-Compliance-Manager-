const { createClient } = require('@supabase/supabase-js');

const DATASET = 'finance_e2e_20260912';
const MARKER = '[FINANCE E2E]';

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main() {
  const service = createClient(required('SUPABASE_URL'), required('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: users, error: usersError } = await service.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (usersError) throw usersError;
  const ownerAuth = users.users.find((user) => user.email === required('MASTER_TEST_EMAIL'));
  if (!ownerAuth) throw new Error('Finance E2E owner identity was not found');
  const { data: profile, error: profileError } = await service.from('user_profiles').select('id,organization_id,role').eq('id', ownerAuth.id).single();
  if (profileError || !profile || !['grand_master', 'master', 'admin'].includes(profile.role)) throw profileError ?? new Error('Finance E2E admin profile unavailable');

  const { data: agreement, error: agreementError } = await service.from('service_agreements').select('id,client_organization_id').eq('provider_organization_id', profile.organization_id).limit(1).single();
  if (agreementError || !agreement) throw agreementError ?? new Error('No provider service agreement exists for finance E2E attribution');

  const { data: existingPeriod } = await service.from('finance_pl_periods').select('id').eq('organization_id', profile.organization_id).eq('name', `${MARKER} September 2026`).maybeSingle();
  let periodId = existingPeriod?.id;
  if (!periodId) {
    const { data, error } = await service.from('finance_pl_periods').insert({ organization_id: profile.organization_id, name: `${MARKER} September 2026`, period_start: '2026-09-01', period_end: '2026-09-30', status: 'draft', created_by: profile.id }).select('id').single();
    if (error) throw error; periodId = data.id;
  }

  const { data: account, error: accountError } = await service.from('bank_accounts').upsert({ organization_id: profile.organization_id, account_name: `${MARKER} ANZ Operating Account`, account_number: 'TEST-ANZ-0001', account_type: 'operating', bank_name: 'ANZ', currency_code: 'NZD', is_active: true, created_by: profile.id }, { onConflict: 'organization_id,account_number' }).select('id').single();
  if (accountError) throw accountError;

  const { data: connection, error: connectionError } = await service.from('finance_external_connection_requests').upsert({ organization_id: profile.organization_id, provider_type: 'bank', provider_name: 'ANZ', connection_mode: 'approved_provider', status: 'connected', requested_scopes: ['account_transactions', 'balances', 'payment_matches'], bank_account_id: account.id, consent_confirmed: true, consent_confirmed_by: profile.id, consent_confirmed_at: new Date().toISOString(), provider_connection_reference: `${DATASET}:connection`, connected_at: new Date().toISOString(), setup_summary: { dataset: DATASET, credentials_collected: false }, created_by: profile.id }, { onConflict: 'organization_id,provider_type,bank_account_id' }).select('id').single();
  if (connectionError) throw connectionError;

  await service.from('finance_tax_periods').upsert({ organization_id: profile.organization_id, period_start: '2026-07-01', period_end: '2026-08-31', filing_due_date: '2026-10-28', status: 'open', output_tax: 2480, input_tax: 620, adjustments: 0, net_tax_due: 1860, created_by: profile.id }, { onConflict: 'organization_id,period_start,period_end' });

  const { data: cost, error: costError } = await service.from('finance_service_costs').insert({ organization_id: profile.organization_id, pl_period_id: periodId, service_agreement_id: agreement.id, client_organization_id: agreement.client_organization_id, cost_type: 'labour', source_document_type: 'estimate', source_reference: `${MARKER} labour`, quantity: 40, unit_of_measure: 'hours', unit_cost: 42, total_cost: 1680, created_by: profile.id }).select('id').single();
  if (costError) throw costError;

  await service.from('finance_pl_snapshots').upsert({ organization_id: profile.organization_id, pl_period_id: periodId, total_revenue: 24800, total_labour: 1680, total_vehicle: 520, total_materials: 340, total_equipment: 180, total_overhead: 610, total_depreciation: 240, total_cost: 3570, gross_profit: 21230, gross_margin_pct: 85.6, cost_line_count: 1, snapshot_at: new Date().toISOString() }, { onConflict: 'pl_period_id' });

  await service.from('finance_external_bank_transactions').upsert([
    { organization_id: profile.organization_id, connection_request_id: connection.id, bank_account_id: account.id, external_transaction_id: `${DATASET}-receipt-1`, transaction_date: '2026-09-05', description: `${MARKER} client payment`, amount: 8200, currency_code: 'NZD', direction: 'credit', raw_summary: { dataset: DATASET }, reconciliation_status: 'unmatched' },
  ], { onConflict: 'connection_request_id,external_transaction_id' });

  console.log(JSON.stringify({ dataset: DATASET, organization_id: profile.organization_id, service_agreement_id: agreement.id, period_id: periodId, bank_account_id: account.id, connection_id: connection.id, finance_cost_id: cost.id, marker: MARKER }, null, 2));
}

main().catch((error) => { console.error(`Finance E2E seed failed: ${error.message}`); process.exitCode = 1; });
