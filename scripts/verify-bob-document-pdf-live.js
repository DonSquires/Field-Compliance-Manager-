const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createClient } = require('@supabase/supabase-js');

const DATASET = 'bob_document_pdf_live_20260911';
const AUTHOR_EMAIL = 'bob-doc-pdf-author@field-compliance.test';
const REVIEWER_EMAIL = 'bob-doc-pdf-reviewer@field-compliance.test';
const INTRUDER_EMAIL = 'bob-doc-pdf-other-org-admin@field-compliance.test';
const OUTPUT_DIR = path.join(__dirname, '..', 'test-results', 'bob-document-pdf-live');
const DOCX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function normalizedSupabaseUrl() {
  return required('SUPABASE_URL').replace(/\/storage\/v1\/upload\/resumable\/?$/, '');
}

function loadAnonKey() {
  if (process.env.SUPABASE_ANON_KEY) return process.env.SUPABASE_ANON_KEY;
  const envPath = '/tmp/fcm-public-vite-env';
  if (!fs.existsSync(envPath)) throw new Error('SUPABASE_ANON_KEY is required or /tmp/fcm-public-vite-env must exist');
  const line = fs.readFileSync(envPath, 'utf8').split(/\r?\n/).find((entry) => entry.startsWith('VITE_SUPABASE_ANON_KEY='));
  const value = line?.slice('VITE_SUPABASE_ANON_KEY='.length).replace(/^['"]|['"]$/g, '');
  if (!value) throw new Error('VITE_SUPABASE_ANON_KEY was not found in /tmp/fcm-public-vite-env');
  return value;
}

function passwordFor(email, seed) {
  return `${crypto.createHmac('sha256', seed).update(email).digest('base64url').slice(0, 24)}Aa1!`;
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
    const { data, error } = await adminClient.auth.admin.updateUserById(existing.id, {
      password,
      email_confirm: true,
      user_metadata: { ...existing.user_metadata, dataset: DATASET },
    });
    if (error) throw error;
    return data.user;
  }
  const { data, error } = await adminClient.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { dataset: DATASET },
  });
  if (error) throw error;
  return data.user;
}

async function ensureOrganization(service, dataset, name) {
  const { data: existing, error: selectError } = await service
    .from('organizations')
    .select('id,name')
    .contains('external_refs', { dataset })
    .maybeSingle();
  if (selectError) throw selectError;
  if (existing) return existing;
  const { data, error } = await service
    .from('organizations')
    .insert({
      name,
      organization_type: 'service_provider',
      status: 'active',
      active: true,
      external_refs: { dataset },
    })
    .select('id,name')
    .single();
  if (error) throw error;
  return data;
}

async function ensureProfile(service, user, organizationId, role, displayName) {
  const { error } = await service.from('user_profiles').upsert({
    id: user.id,
    organization_id: organizationId,
    role,
    display_name: displayName,
    email: user.email,
    authorized_organization_ids: [],
    module_access: [],
  }, { onConflict: 'id' });
  if (error) throw error;
}

function clientFor(url, anonKey) {
  return createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function signIn(url, anonKey, email, password) {
  const client = clientFor(url, anonKey);
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.session) throw error ?? new Error(`Authentication failed for ${email}`);
  return { client, session: data.session };
}

async function expectRpcRejected(label, call) {
  const { error } = await call();
  if (!error) throw new Error(`${label} unexpectedly succeeded`);
  return error.message;
}

async function expectRendererRejected(label, url, anonKey, accessToken, outputId, expectedStatus) {
  const response = await fetch(`${url}/functions/v1/generate-bob-document-output`, {
    method: 'POST',
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ output_id: outputId }),
  });
  if (response.status !== expectedStatus) {
    const body = await response.text();
    throw new Error(`${label} returned ${response.status}, expected ${expectedStatus}: ${body}`);
  }
  return response.status;
}

async function generateOutput(url, anonKey, accessToken, outputId) {
  const response = await fetch(`${url}/functions/v1/generate-bob-document-output`, {
    method: 'POST',
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ output_id: outputId }),
  });
  const generated = await response.json();
  if (!response.ok || !generated.output) throw new Error(generated.error || `Renderer returned ${response.status}`);
  return generated.output;
}

async function downloadVerifiedOutput(service, readyOutput, expectedMimeType, extension, signature) {
  if (readyOutput.status !== 'ready') throw new Error(`Unexpected ${extension} output status: ${readyOutput.status}`);
  if (readyOutput.mime_type !== expectedMimeType) throw new Error(`Unexpected ${extension} MIME type: ${readyOutput.mime_type}`);
  if (!readyOutput.sha256 || !readyOutput.storage_bucket || !readyOutput.storage_path) throw new Error(`Ready ${extension} output is missing storage metadata`);
  if (!readyOutput.storage_path.endsWith(`.${extension}`)) throw new Error(`Ready ${extension} output path has the wrong extension: ${readyOutput.storage_path}`);
  const { data: blob, error } = await service.storage.from(readyOutput.storage_bucket).download(readyOutput.storage_path);
  if (error || !blob) throw error ?? new Error(`Generated ${extension} could not be downloaded`);
  const bytes = Buffer.from(await blob.arrayBuffer());
  const computedSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  if (computedSha256 !== readyOutput.sha256) throw new Error(`Downloaded ${extension} SHA-256 does not match output metadata`);
  if (!bytes.subarray(0, signature.length).equals(signature)) throw new Error(`Downloaded output is not a ${extension} file`);
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const outputPath = path.join(OUTPUT_DIR, `${readyOutput.id}.${extension}`);
  fs.writeFileSync(outputPath, bytes);
  return { bytes, outputPath };
}

async function main() {
  const url = normalizedSupabaseUrl();
  const serviceKey = required('SUPABASE_SERVICE_ROLE_KEY');
  const anonKey = loadAnonKey();
  const passwordSeed = process.env.BOB_DOC_PDF_E2E_PASSWORD_SEED || process.env.GRANDMASTER_TEST_PASSWORD || required('FIELD_COMPLIANCE_CODESPACE');
  const service = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const organization = await ensureOrganization(service, DATASET, 'Bob Document PDF Live Verification');
  const intruderOrganization = await ensureOrganization(service, `${DATASET}_other_org`, 'Bob Document PDF Other Org Verification');
  const authorPassword = passwordFor(AUTHOR_EMAIL, passwordSeed);
  const reviewerPassword = passwordFor(REVIEWER_EMAIL, passwordSeed);
  const intruderPassword = passwordFor(INTRUDER_EMAIL, passwordSeed);
  const authorUser = await ensureAuthUser(service, AUTHOR_EMAIL, authorPassword);
  const reviewerUser = await ensureAuthUser(service, REVIEWER_EMAIL, reviewerPassword);
  const intruderUser = await ensureAuthUser(service, INTRUDER_EMAIL, intruderPassword);
  await ensureProfile(service, authorUser, organization.id, 'admin', 'Bob PDF Test Author');
  await ensureProfile(service, reviewerUser, organization.id, 'admin', 'Bob PDF Test Reviewer');
  await ensureProfile(service, intruderUser, intruderOrganization.id, 'admin', 'Bob PDF Other Org Admin');

  const { client: author } = await signIn(url, anonKey, AUTHOR_EMAIL, authorPassword);
  const { client: reviewer, session: reviewerSession } = await signIn(url, anonKey, REVIEWER_EMAIL, reviewerPassword);
  const { session: intruderSession } = await signIn(url, anonKey, INTRUDER_EMAIL, intruderPassword);
  const title = `Bob live PDF acceptance ${new Date().toISOString()}`;
  const authoredHtml = '<h1>Field Compliance Manager PDF acceptance</h1><p>This governed document verifies approved PDF output generation.</p><ul><li>What: acceptance report</li><li>When: current live test run</li><li>Why: enterprise output assurance</li></ul>';
  const authoredText = 'Field Compliance Manager PDF acceptance\nThis governed document verifies approved PDF output generation.\nWhat: acceptance report\nWhen: current live test run\nWhy: enterprise output assurance';
  const { data: draft, error: draftError } = await author.rpc('create_bob_document_draft', {
    p_title: title,
    p_document_type: 'report',
    p_authored_html: authoredHtml,
    p_authored_text: authoredText,
    p_reference_handles: [],
    p_reference_metadata: [],
  });
  if (draftError) throw draftError;
  const documentId = draft.document_id;
  const versionId = draft.document_version_id;
  const draftOutputError = await expectRpcRejected('Draft output request', () => author.rpc('request_bob_document_output', {
    p_document_id: documentId,
    p_document_version_id: versionId,
    p_output_format: 'pdf',
  }));
  const { error: submitError } = await author.rpc('submit_bob_document_for_review', {
    p_document_id: documentId,
    p_document_version_id: versionId,
    p_review_reason: 'Live PDF acceptance test submission',
  });
  if (submitError) throw submitError;
  const selfReviewError = await expectRpcRejected('Self review', () => author.rpc('review_bob_document_draft', {
    p_document_id: documentId,
    p_document_version_id: versionId,
    p_decision: 'approved',
    p_review_reason: 'Self-review must be blocked by governance',
  }));
  const { error: reviewError } = await reviewer.rpc('review_bob_document_draft', {
    p_document_id: documentId,
    p_document_version_id: versionId,
    p_decision: 'approved',
    p_review_reason: 'Approved for live PDF renderer acceptance test',
  });
  if (reviewError) throw reviewError;
  const { data: output, error: outputError } = await reviewer.rpc('request_bob_document_output', {
    p_document_id: documentId,
    p_document_version_id: versionId,
    p_output_format: 'pdf',
  });
  if (outputError) throw outputError;
  const crossOrgRenderStatus = await expectRendererRejected('Cross-org renderer access', url, anonKey, intruderSession.access_token, output.id, 403);

  const readyOutput = await generateOutput(url, anonKey, reviewerSession.access_token, output.id);
  const pdfArtifact = await downloadVerifiedOutput(service, readyOutput, 'application/pdf', 'pdf', Buffer.from('%PDF-'));
  const { data: docxOutput, error: docxOutputError } = await reviewer.rpc('request_bob_document_output', {
    p_document_id: documentId,
    p_document_version_id: versionId,
    p_output_format: 'docx',
  });
  if (docxOutputError) throw docxOutputError;
  const readyDocxOutput = await generateOutput(url, anonKey, reviewerSession.access_token, docxOutput.id);
  const docxArtifact = await downloadVerifiedOutput(service, readyDocxOutput, DOCX_MIME_TYPE, 'docx', Buffer.from('PK'));
  const { data: auditRows, error: auditError } = await service
    .from('audit_log')
    .select('action')
    .eq('target_id', readyOutput.id);
  if (auditError) throw auditError;
  const actions = new Set((auditRows || []).map((row) => row.action));
  if (!actions.has('bob_document_output_requested') || !actions.has('bob_document_output_generated')) {
    throw new Error('Output request/generated audit rows were not both found');
  }

  console.log(JSON.stringify({
    ok: true,
    organization: organization.name,
    document_id: documentId,
    document_version_id: versionId,
    output_id: readyOutput.id,
    mime_type: readyOutput.mime_type,
    renderer_version: readyOutput.renderer_version,
    sha256: readyOutput.sha256,
    byte_length: pdfArtifact.bytes.length,
    pdf_path: path.relative(path.join(__dirname, '..'), pdfArtifact.outputPath),
    docx_output_id: readyDocxOutput.id,
    docx_mime_type: readyDocxOutput.mime_type,
    docx_renderer_version: readyDocxOutput.renderer_version,
    docx_sha256: readyDocxOutput.sha256,
    docx_byte_length: docxArtifact.bytes.length,
    docx_path: path.relative(path.join(__dirname, '..'), docxArtifact.outputPath),
    audit_actions: [...actions].sort(),
    negative_checks: {
      draft_output_denied: draftOutputError,
      self_review_denied: selfReviewError,
      cross_org_render_status: crossOrgRenderStatus,
    },
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});