const crypto = require('node:crypto');
const { createClient } = require('@supabase/supabase-js');

const DATASET = 'aam_e2e_20260831';
const ADMIN_EMAIL = 'aam-e2e-admin@field-compliance.test';
const OFFICER_EMAILS = Array.from({ length: 5 }, (_, index) => `aam-e2e-officer-${index + 1}@field-compliance.test`);
const OPERATIONAL_MODULES = ['access_control', 'biosecurity', 'ems', 'freedom_camping', 'noise_control', 'parking_enforcement', 'patrol', 'smoke_complaints', 'static_guarding'];
const SHIFT_TYPES = ['day', 'swing', 'night', 'overnight', 'split'];

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function passwordFor(email, seed) {
  return `${crypto.createHmac('sha256', seed).update(email).digest('base64url').slice(0, 24)}Aa1!`;
}

function sameValues(actual, expected) {
  return JSON.stringify([...new Set(actual)].sort()) === JSON.stringify([...expected].sort());
}

async function findAuthUser(adminClient, email) {
  for (let page = 1; page <= 10; page += 1) {
    const { data, error } = await adminClient.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    const match = data.users.find((user) => user.email === email);
    if (match) return match;
    if (data.users.length < 1000) return null;
  }
  throw new Error('Auth user search exceeded page limit');
}

async function ensureAuthUser(adminClient, email, password) {
  const existing = await findAuthUser(adminClient, email);
  if (existing) {
    if (existing.user_metadata?.dataset !== DATASET) throw new Error(`Refusing to reuse unmarked auth identity: ${email}`);
    const { data, error } = await adminClient.auth.admin.updateUserById(existing.id, { password, email_confirm: true, user_metadata: { ...existing.user_metadata, dataset: DATASET } });
    if (error) throw error;
    return data.user;
  }
  const { data, error } = await adminClient.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { dataset: DATASET } });
  if (error) throw error;
  return data.user;
}

async function main() {
  const url = required('SUPABASE_URL');
  const serviceKey = required('SUPABASE_SERVICE_ROLE_KEY');
  const passwordSeed = process.env.AAM_E2E_PASSWORD_SEED || required('GRANDMASTER_TEST_PASSWORD');
  const service = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  const ownerAuth = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: ownerSession, error: ownerSignInError } = await ownerAuth.auth.signInWithPassword({ email: required('GRANDMASTER_TEST_EMAIL'), password: required('GRANDMASTER_TEST_PASSWORD') });
  if (ownerSignInError || !ownerSession.user) throw ownerSignInError ?? new Error('Provider owner authentication failed');
  const { data: owner, error: ownerError } = await service.from('user_profiles').select('id,organization_id,role').eq('id', ownerSession.user.id).single();
  if (ownerError || !owner || !['grand_master', 'master', 'admin'].includes(owner.role)) throw ownerError ?? new Error('Authorized provider owner not found');

  const adminPassword = passwordFor(ADMIN_EMAIL, passwordSeed);
  const adminUser = await ensureAuthUser(service, ADMIN_EMAIL, adminPassword);
  const officerUsers = [];
  for (const email of OFFICER_EMAILS) officerUsers.push(await ensureAuthUser(service, email, passwordFor(email, passwordSeed)));
  for (const email of OFFICER_EMAILS) {
    const officerClient = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data, error } = await officerClient.auth.signInWithPassword({ email, password: passwordFor(email, passwordSeed) });
    if (error || !data.user) throw error ?? new Error(`Officer authentication failed for ${email}`);
  }

  const { data: manifest, error: seedError } = await service.rpc('seed_aam_e2e_dataset', {
    p_provider_organization_id: owner.organization_id,
    p_owner_user_id: owner.id,
    p_admin_user_id: adminUser.id,
    p_admin_email: ADMIN_EMAIL,
    p_officer_user_ids: officerUsers.map((user) => user.id),
    p_officer_emails: OFFICER_EMAILS,
  });
  if (seedError) throw seedError;

  const actor = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error: signInError } = await actor.auth.signInWithPassword({ email: ADMIN_EMAIL, password: adminPassword });
  if (signInError) throw signInError;

  const loadLedger = async () => {
    const { data, error } = await actor.rpc('get_crm_onboarding_workspace');
    if (error) throw error;
    const row = data.find((item) => item.account_organization_id === manifest.account_id);
    if (!row) throw new Error('AAM onboarding ledger not found');
    return row;
  };
  let ledger = await loadLedger();
  for (const stage of ['configure', 'review']) {
    const { error } = await actor.rpc('manage_crm_onboarding_workflow', { p_account_organization_id: manifest.account_id, p_expected_version: ledger.version, p_stage: stage, p_target_live_at: new Date(Date.now() + 14 * 86400000).toISOString(), p_assigned_to: adminUser.id, p_note: `[AAM E2E] ${stage} evidence verified by the synthetic account administrator.` });
    if (error) throw error;
    ledger = await loadLedger();
  }
  const { error: activationError } = await actor.rpc('activate_crm_account', { p_account_organization_id: manifest.account_id, p_agreement_id: manifest.agreement_id, p_expected_organization_updated_at: ledger.organization_updated_at, p_expected_ledger_version: ledger.version });
  if (activationError) throw activationError;

  const slotStart = new Date(Date.now() + 86400000); slotStart.setUTCHours(8, 0, 0, 0);
  const slotEnd = new Date(slotStart.getTime() + 8 * 3600000);
  const { data: slot, error: slotError } = await actor.rpc('create_roster_slot', { p_client_request_id: crypto.randomUUID(), p_work_unit_id: manifest.work_unit_id, p_staff_id: officerUsers[0].id, p_scheduled_start: slotStart.toISOString(), p_scheduled_end: slotEnd.toISOString(), p_publish: true, p_notes: '[AAM E2E] First post-activation roster action' });
  if (slotError) throw slotError;
  const { error: materializeError } = await actor.rpc('materialize_roster_slot', { p_slot_id: slot.id });
  if (materializeError) throw materializeError;

  const zoneByModule = new Map(manifest.operational_zones.map((zone) => [zone.module_key, zone.zone_id]));
  for (const [index, moduleKey] of OPERATIONAL_MODULES.entries()) {
    const start = new Date(Date.now() + (index + 3) * 86400000); start.setUTCHours(8, 0, 0, 0);
    const end = new Date(start.getTime() + 8 * 3600000);
    const useZone = index % 2 === 1;
    const { error } = await actor.rpc('create_roster_shift', { p_officer_user_id: officerUsers[index % officerUsers.length].id, p_service_type: moduleKey, p_scheduled_start: start.toISOString(), p_scheduled_end: end.toISOString(), p_location_id: useZone ? null : manifest.location_id, p_zone_id: useZone ? zoneByModule.get(moduleKey) : null, p_patrol_route_id: null, p_notes: `[AAM E2E] ${moduleKey} ${useZone ? 'zone' : 'site'} shift`, p_publish: true });
    if (error) throw error;
  }

  const { data: handoffs, error: handoffError } = await actor.rpc('get_crm_activation_handoffs');
  if (handoffError) throw handoffError;
  let handoff = handoffs.find((item) => item.account_organization_id === manifest.account_id);
  if (!handoff) throw new Error('AAM activation handoff not found');
  for (const task of handoff.tasks) {
    const { error } = await actor.rpc('manage_crm_activation_handoff_task', { p_handoff_id: handoff.handoff_id, p_task_id: task.task_id, p_expected_version: handoff.version, p_complete: true, p_note: `[AAM E2E] ${task.title} verified against synthetic evidence.` });
    if (error) throw error;
    const { data, error: reloadError } = await actor.rpc('get_crm_activation_handoffs');
    if (reloadError) throw reloadError;
    handoff = data.find((item) => item.handoff_id === handoff.handoff_id);
  }

  const [moduleResult, templateResult, shiftResult] = await Promise.all([
    service.from('service_agreement_modules').select('module_key').eq('service_agreement_id', manifest.agreement_id).eq('enabled', true),
    service.from('shift_templates').select('shift_type').eq('organization_id', owner.organization_id).like('name', '[AAM E2E]%'),
    service.from('shifts').select('service_type,location_id,zone_id').eq('organization_id', owner.organization_id).like('notes', '[AAM E2E]%'),
  ]);
  if (moduleResult.error || templateResult.error || shiftResult.error) throw moduleResult.error ?? templateResult.error ?? shiftResult.error;
  const moduleKeys = moduleResult.data.map((row) => row.module_key);
  const templateTypes = templateResult.data.map((row) => row.shift_type);
  const shiftServices = shiftResult.data.map((row) => row.service_type);
  const targetsSiteAndZone = shiftResult.data.some((row) => row.location_id) && shiftResult.data.some((row) => row.zone_id);
  if (moduleKeys.length !== manifest.active_module_count || !sameValues(templateTypes, SHIFT_TYPES) || !OPERATIONAL_MODULES.every((moduleKey) => shiftServices.includes(moduleKey)) || shiftResult.data.length !== OPERATIONAL_MODULES.length + 1 || !targetsSiteAndZone || handoff.handoff_status !== 'completed') throw new Error('AAM verification evidence did not match the requested dataset');
  console.log(JSON.stringify({ dataset: DATASET, account: 'AAM End-to-End Test Account', authenticatedUsers: 6, activeModules: moduleKeys.length, operationalZones: manifest.operational_zones.length, shiftTypes: templateTypes.sort(), operationalShiftModules: [...new Set(shiftServices)].sort(), targets: ['site', 'zone'], shifts: shiftResult.data.length, onboarding: 'activated', handoff: handoff.handoff_status }));
}

main().catch((error) => { console.error(`AAM E2E seed failed: ${error.message}`); process.exitCode = 1; });