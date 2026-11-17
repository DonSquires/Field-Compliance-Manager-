'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { execFileSync } = require('node:child_process');
const { randomUUID, createHash } = require('node:crypto');

const migrationPath = path.join(__dirname, '../supabase/migrations/20261117082018_bob_document_automated_review.sql');
const migration = fs.readFileSync(migrationPath, 'utf8');

test('automated review is service-only, source-pinned, private-provider-only and never impersonates a human', () => {
  assert.match(migration, /bob_document_auto_review_receipts/);
  assert.match(migration, /source_updated_at/);
  assert.match(migration, /source_file_sha256/);
  assert.match(migration, /source_text_sha256/);
  assert.match(migration, /auth\.jwt\(\) ->> 'role'\) IS DISTINCT FROM 'service_role'/);
  assert.match(migration, /'gpu_workstation', 'ollama'/);
  assert.match(migration, /VALUES \(v_document\.organization_id, NULL, v_action/);
  assert.match(migration, /document-studio/);
  assert.match(migration, /reviewed_by = NULL/);
});

test('Postgres records automated draft and quarantine receipts without a human actor', {
  skip: process.env.BOB_TEST_POSTGRES !== '1',
  timeout: 90000,
}, async () => {
  const container = `fcm-document-review-${randomUUID()}`;
  const docker = args => execFileSync('docker', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  let created = false;
  try {
    docker(['run', '--detach', '--name', container, '--network', 'none', '--mount', 'type=tmpfs,destination=/var/lib/postgresql/data', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgis/postgis:17-3.5']);
    created = true;
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try { docker(['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']); ready = true; break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.ok(ready, 'disposable Postgres must become ready');
    const sql = query => execFileSync('docker', ['exec', '-i', container, 'psql', '-XAtq', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres'], {
      input: query, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    sql(`
      CREATE ROLE anon NOLOGIN;
      CREATE ROLE authenticated NOLOGIN;
      CREATE ROLE service_role NOLOGIN BYPASSRLS;
      CREATE SCHEMA extensions;
      CREATE EXTENSION pgcrypto WITH SCHEMA extensions;
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$
        SELECT jsonb_build_object('role', current_setting('test.role', true))
      $$;
      CREATE TABLE public.organizations(id uuid PRIMARY KEY, name text, organization_type text, parent_organization_id uuid, active boolean DEFAULT true);
      CREATE TABLE public.documents(id uuid PRIMARY KEY, organization_id uuid, sha256 text, current_scope text, uploaded_by uuid, updated_at timestamptz DEFAULT now());
      CREATE TABLE public.document_versions(id uuid PRIMARY KEY, document_id uuid REFERENCES public.documents(id), extracted_text text, ocr_required boolean DEFAULT false, metadata_json jsonb DEFAULT '{}', updated_at timestamptz DEFAULT now());
      CREATE TABLE public.document_promotion_proposals(id uuid PRIMARY KEY, organization_id uuid, document_version_id uuid, target_type text, proposed_payload jsonb DEFAULT '{}', source_map jsonb DEFAULT '{}', status text, requested_by uuid, reviewed_by uuid, reviewed_at timestamptz, review_reason text, applied_target_id uuid, applied_at timestamptz, updated_at timestamptz DEFAULT now());
      CREATE TABLE public.document_classifications(id uuid DEFAULT gen_random_uuid(), document_version_id uuid, privacy_class text, contains_pii boolean, contains_operational_security boolean, contains_financial_data boolean, contains_legal_privilege boolean, classifier_source text, confidence real, rationale text, reviewed_by uuid, reviewed_at timestamptz);
      CREATE TABLE public.service_agreements(id uuid DEFAULT gen_random_uuid(), provider_organization_id uuid, client_organization_id uuid, name text, starts_on date, ends_on date, agreement_type text, invitation_status text, enabled_modules text[], external_refs jsonb);
      CREATE TABLE public.invoices(id uuid DEFAULT gen_random_uuid(), organization_id uuid, client_organization_id uuid, service_agreement_id uuid, invoice_number text, invoice_date date, due_date date, status text, subtotal numeric, gst_amount numeric, total_amount numeric, currency text, notes text, created_by uuid);
      CREATE TABLE public.audit_log(id uuid DEFAULT gen_random_uuid(), organization_id uuid, actor_user_id uuid, action text, target_table text, target_id uuid, metadata jsonb DEFAULT '{}');
      CREATE TABLE public.test_notifications(id uuid DEFAULT gen_random_uuid(), organization_id uuid, recipient_user_id uuid, recipient_role text, link_page text, link_payload jsonb, body text);
      CREATE FUNCTION public.enqueue_notification(p_organization_id uuid, p_category text, p_title text, p_body text, p_severity text, p_recipient_user_id uuid DEFAULT NULL, p_recipient_role text DEFAULT NULL, p_link_page text DEFAULT NULL, p_link_payload jsonb DEFAULT NULL, p_dedup_key text DEFAULT NULL) RETURNS uuid LANGUAGE sql AS $$ INSERT INTO public.test_notifications(organization_id,recipient_user_id,recipient_role,link_page,link_payload,body) VALUES(p_organization_id,p_recipient_user_id,p_recipient_role,p_link_page,p_link_payload,p_body) RETURNING id $$;
      CREATE FUNCTION public.promote_document_to_reference_library(p_document_version_id uuid, p_target_scope text, p_approver_id uuid, p_metadata jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE sql AS $$ SELECT jsonb_build_object('ok', true, 'catalog_entry_id', gen_random_uuid()) $$;
      INSERT INTO public.organizations(id,name,organization_type,parent_organization_id,active) VALUES
        ('11111111-1111-4111-8111-111111111111','Provider','provider',NULL,true),
        ('22222222-2222-4222-8222-222222222222','Client','client','11111111-1111-4111-8111-111111111111',true);
    `);
    sql(migration);

    const orgId = '11111111-1111-4111-8111-111111111111';
    const verification = receiptId => `(SELECT jsonb_build_object('source_verification', jsonb_build_object('method','utf8_bytes_v1','file_sha256',source_file_sha256,'text_sha256',source_text_sha256), 'reviewed_proposal', proposal_snapshot) FROM public.bob_document_auto_review_receipts WHERE id='${receiptId}')`;
    const draftId = randomUUID();
    const draftVersionId = randomUUID();
    const sourceText = 'Title: Safety Plan';
    const sourceHash = createHash('sha256').update(sourceText).digest('hex');
    sql(`INSERT INTO public.documents(id,organization_id,sha256,current_scope) VALUES ('${draftId}','${orgId}','${'a'.repeat(64)}','conversation_only');
      INSERT INTO public.document_versions(id,document_id,extracted_text,metadata_json) VALUES ('${draftVersionId}','${draftId}','${sourceText}','{"authoring_status":"needs_review","authored_text":"Title: Safety Plan"}');`);
    const draftClaim = sql(`SELECT set_config('test.role','service_role',false); SELECT receipt_id FROM public.claim_bob_document_auto_review('${draftVersionId}','draft',NULL,'${sourceHash}');`).split('\n').at(-1);
    assert.equal(sql(`SELECT encode(extensions.digest(convert_to(extracted_text,'UTF8'),'sha256'),'hex') FROM public.document_versions WHERE id='${draftVersionId}'`), sourceHash);
    assert.equal(sql(`SELECT source_text_sha256 FROM public.bob_document_auto_review_receipts WHERE id='${draftClaim}'`), sourceHash);
    const reviewers = JSON.stringify([
      { role: 'bob', provider: 'gpu_workstation', model: 'bob-private', confidence: 0.99 },
      { role: 'oracle', provider: 'ollama', model: 'oracle-private', confidence: 0.99 },
    ]).replaceAll("'", "''");
    const claims = JSON.stringify([{
      field: 'title', value_hash: createHash('sha256').update('Safety Plan').digest('hex'),
      quote_hash: sourceHash, source_start: 0, source_end: sourceText.length, confidence: 0.99,
    }]).replaceAll("'", "''");
    const oldToken = sql(`SELECT lease_token FROM public.bob_document_auto_review_receipts WHERE id='${draftClaim}'`);
    sql(`UPDATE public.bob_document_auto_review_receipts SET lease_expires_at = now() - interval '1 second' WHERE id='${draftClaim}';`);
    sql(`SELECT set_config('test.role','service_role',false); SELECT * FROM public.claim_bob_document_auto_review('${draftVersionId}','draft',NULL,'${sourceHash}');`);
    assert.throws(() => sql(`SELECT set_config('test.role','service_role',false); SELECT public.finish_bob_document_auto_review('${draftClaim}','blocked','old worker','[]','[]',NULL,NULL,'{}','${oldToken}');`), /lease is stale/);
    assert.throws(() => sql(`SELECT set_config('test.role','service_role',false); SELECT public.finish_bob_document_auto_review('${draftClaim}','approved','source_verified','${reviewers}'::jsonb,'${claims}'::jsonb,NULL,NULL,${verification(draftClaim)}, (SELECT lease_token FROM public.bob_document_auto_review_receipts WHERE id='${draftClaim}'));`), /frozen independent/);
    sql(`SELECT set_config('test.role','service_role',false); SELECT public.finish_bob_document_auto_review('${draftClaim}','blocked','Draft lacks independent source evidence','[]','[]',NULL,NULL,'{}', (SELECT lease_token FROM public.bob_document_auto_review_receipts WHERE id='${draftClaim}'));`);
    assert.equal(sql(`SELECT metadata_json->>'authoring_status' FROM public.document_versions WHERE id='${draftVersionId}'`), 'needs_review');
    assert.equal(sql(`SELECT actor_user_id IS NULL FROM public.audit_log WHERE action='bob_document_auto_review_decided' AND target_id='${draftVersionId}'`), 't');
    assert.equal(sql(`SELECT link_page='document-studio' AND link_payload->>'document_id'='${draftId}' AND recipient_role='admin' FROM public.test_notifications WHERE link_payload->>'version_id'='${draftVersionId}'`), 't');

    const blockedId = randomUUID();
    const blockedVersion = randomUUID();
    sql(`INSERT INTO public.documents(id,organization_id,sha256,current_scope) VALUES ('${blockedId}','${orgId}','${'b'.repeat(64)}','tenant');
      INSERT INTO public.document_versions(id,document_id,ocr_required) VALUES ('${blockedVersion}','${blockedId}',true);`);
    const emptyTextHash = createHash('sha256').update('').digest('hex');
    const blockedClaim = sql(`SELECT set_config('test.role','service_role',false); SELECT receipt_id FROM public.claim_bob_document_auto_review('${blockedVersion}','classification',NULL,'${emptyTextHash}');`).split('\n').at(-1);
    sql(`SELECT set_config('test.role','service_role',false); SELECT public.finish_bob_document_auto_review('${blockedClaim}','quarantined','ocr_incomplete','[]'::jsonb,'[]'::jsonb,NULL,NULL,'{}', (SELECT lease_token FROM public.bob_document_auto_review_receipts WHERE id='${blockedClaim}'));`);
    assert.equal(sql(`SELECT current_scope FROM public.documents WHERE id='${blockedId}'`), 'quarantined');
    assert.equal(sql(`SELECT count(*) FROM public.document_classifications WHERE document_version_id='${blockedVersion}'`), '0');

    const sensitiveDocumentId = randomUUID();
    const sensitiveVersionId = randomUUID();
    const sensitiveSource = 'Contact: Example';
    const sensitiveHash = createHash('sha256').update(sensitiveSource).digest('hex');
    sql(`INSERT INTO public.documents(id,organization_id,sha256,current_scope) VALUES ('${sensitiveDocumentId}','${orgId}','${'c'.repeat(64)}','tenant');
      INSERT INTO public.document_versions(id,document_id,extracted_text) VALUES ('${sensitiveVersionId}','${sensitiveDocumentId}','${sensitiveSource}');`);
    const sensitiveClaim = sql(`SELECT set_config('test.role','service_role',false); SELECT receipt_id FROM public.claim_bob_document_auto_review('${sensitiveVersionId}','classification',NULL,'${sensitiveHash}');`).split('\n').at(-1);
    const sensitiveSourceClaim = JSON.stringify([{
      field: 'contact', value_hash: createHash('sha256').update('Example').digest('hex'),
      quote_hash: createHash('sha256').update(sensitiveSource).digest('hex'),
      source_start: 0, source_end: sensitiveSource.length, confidence: 0.99,
    }]).replaceAll("'", "''");
    const privacyAssessment = JSON.stringify({
      privacy_class: 'public', contains_pii: true, contains_operational_security: false,
      contains_financial_data: false, contains_legal_privilege: false, confidence: 0.99,
    }).replaceAll("'", "''");
    sql(`SELECT set_config('test.role','service_role',false); SELECT public.finish_bob_document_auto_review('${sensitiveClaim}','approved','source_verified','${reviewers}'::jsonb,'${sensitiveSourceClaim}'::jsonb,'${privacyAssessment}'::jsonb,'global_reference',${verification(sensitiveClaim)}, (SELECT lease_token FROM public.bob_document_auto_review_receipts WHERE id='${sensitiveClaim}'));`);
    assert.equal(sql(`SELECT current_scope FROM public.documents WHERE id='${sensitiveDocumentId}'`), 'quarantined');
    assert.equal(sql(`SELECT privacy_class || ':' || classifier_source FROM public.document_classifications WHERE document_version_id='${sensitiveVersionId}'`), 'restricted:bob');

    const proposalDocumentId = randomUUID();
    const proposalVersionId = randomUUID();
    const proposalId = randomUUID();
    const proposalSource = 'Agreement: Field coverage\nClient: Client';
    const proposalHash = createHash('sha256').update(proposalSource).digest('hex');
    sql(`INSERT INTO public.documents(id,organization_id,sha256,current_scope) VALUES ('${proposalDocumentId}','${orgId}','${'d'.repeat(64)}','tenant');
      INSERT INTO public.document_versions(id,document_id,extracted_text) VALUES ('${proposalVersionId}','${proposalDocumentId}','${proposalSource}');
      INSERT INTO public.document_promotion_proposals(id,organization_id,document_version_id,target_type,proposed_payload,status,requested_by)
      VALUES ('${proposalId}','${orgId}','${proposalVersionId}','crm_agreement','{"name":"Field coverage","client_name":"Client"}','proposed','33333333-3333-4333-8333-333333333333');`);
    const proposalClaim = sql(`SELECT set_config('test.role','service_role',false); SELECT receipt_id FROM public.claim_bob_document_auto_review('${proposalVersionId}','promotion','${proposalId}','${proposalHash}');`).split('\n').at(-1);
    const makeSourceClaim = (source, field, value, quote) => {
      const sourceStart = source.indexOf(quote);
      return {
        field,
        value_hash: createHash('sha256').update(value).digest('hex'),
        quote_hash: createHash('sha256').update(quote).digest('hex'),
        source_start: sourceStart,
        source_end: sourceStart + quote.length,
        confidence: 0.99,
      };
    };
    const sourceClaims = JSON.stringify([
      makeSourceClaim(proposalSource, 'name', 'Field coverage', 'Field coverage'),
      makeSourceClaim(proposalSource, 'client_name', 'Client', 'Client'),
    ]).replaceAll("'", "''");
    sql(`SELECT set_config('test.role','service_role',false); SELECT public.finish_bob_document_auto_review('${proposalClaim}','approved','source_verified','${reviewers}'::jsonb,'${sourceClaims}'::jsonb,NULL,NULL,${verification(proposalClaim)}, (SELECT lease_token FROM public.bob_document_auto_review_receipts WHERE id='${proposalClaim}'));`);
    const application = JSON.parse(sql(`SELECT set_config('test.role','service_role',false); SELECT public.apply_bob_document_auto_proposal('${proposalClaim}');`).split('\n').at(-1));
    assert.equal(application.status, 'blocked');
    assert.match(application.reason, /grants operational access/);
    assert.equal(sql('SELECT count(*) FROM public.service_agreements'), '0');
    assert.equal(sql(`SELECT reviewed_by IS NULL AND applied_target_id IS NULL FROM public.document_promotion_proposals WHERE id='${proposalId}'`), 't');

    sql(`INSERT INTO public.service_agreements(provider_organization_id,client_organization_id,name,agreement_type)
      VALUES ('${orgId}','22222222-2222-4222-8222-222222222222','Existing synthetic operational relationship','operational');`);

    const invoiceDocumentId = randomUUID();
    const invoiceVersionId = randomUUID();
    const invoiceProposalId = randomUUID();
    const invoiceSource = 'Invoice: INV-001\nClient: Client\nInvoice date: 2026-01-01\nDue date: 2026-01-31\nSubtotal: 100.00\nGST: 15.00\nTotal: 115.00\nCurrency: NZD\nAlternative currency: USD';
    const invoiceHash = createHash('sha256').update(invoiceSource).digest('hex');
    sql(`INSERT INTO public.documents(id,organization_id,sha256,current_scope) VALUES ('${invoiceDocumentId}','${orgId}','${'e'.repeat(64)}','tenant');
      INSERT INTO public.document_versions(id,document_id,extracted_text) VALUES ('${invoiceVersionId}','${invoiceDocumentId}','${invoiceSource}');
      INSERT INTO public.document_promotion_proposals(id,organization_id,document_version_id,target_type,proposed_payload,status,requested_by)
      VALUES ('${invoiceProposalId}','${orgId}','${invoiceVersionId}','finance_reconciliation','{"invoice_number":"INV-001","client_name":"Client","invoice_date":"2026-01-01","due_date":"2026-01-31","subtotal":100,"gst_amount":15,"total_amount":115,"currency":"NZD"}','proposed','33333333-3333-4333-8333-333333333333');`);
    const invoiceClaim = sql(`SELECT set_config('test.role','service_role',false); SELECT receipt_id FROM public.claim_bob_document_auto_review('${invoiceVersionId}','promotion','${invoiceProposalId}','${invoiceHash}');`).split('\n').at(-1);
    const invoiceFields = [
      ['invoice_number', 'INV-001', 'Invoice: INV-001'], ['client_name', 'Client', 'Client: Client'],
      ['invoice_date', '2026-01-01', 'Invoice date: 2026-01-01'], ['due_date', '2026-01-31', 'Due date: 2026-01-31'],
      ['subtotal', '100', 'Subtotal: 100.00'], ['gst_amount', '15', 'GST: 15.00'], ['total_amount', '115', 'Total: 115.00'],
      ['currency', 'NZD', 'Currency: NZD'],
    ];
    const invoiceSourceClaims = JSON.stringify(invoiceFields.map(([field, value, quote]) => makeSourceClaim(invoiceSource, field, value, quote))).replaceAll("'", "''");
    sql(`SELECT set_config('test.role','service_role',false); SELECT public.finish_bob_document_auto_review('${invoiceClaim}','approved','source_verified','${reviewers}'::jsonb,'${invoiceSourceClaims}'::jsonb,NULL,NULL,${verification(invoiceClaim)}, (SELECT lease_token FROM public.bob_document_auto_review_receipts WHERE id='${invoiceClaim}'));`);
    const invoiceApplication = JSON.parse(sql(`SELECT set_config('test.role','service_role',false); SELECT public.apply_bob_document_auto_proposal('${invoiceClaim}');`).split('\n').at(-1));
    assert.equal(invoiceApplication.status, 'applied');
    assert.equal(sql(`SELECT status='draft' AND created_by IS NULL AND total_amount=115 FROM public.invoices WHERE id='${invoiceApplication.target_id}'`), 't');

    const changedProposalId = randomUUID();
    sql(`INSERT INTO public.document_promotion_proposals(id,organization_id,document_version_id,target_type,proposed_payload,status,requested_by)
      SELECT '${changedProposalId}',organization_id,document_version_id,target_type,proposed_payload,'proposed',requested_by FROM public.document_promotion_proposals WHERE id='${invoiceProposalId}'`);
    const changedClaim = sql(`SELECT set_config('test.role','service_role',false); SELECT receipt_id FROM public.claim_bob_document_auto_review('${invoiceVersionId}','promotion','${changedProposalId}','${invoiceHash}');`).split('\n').at(-1);
    sql(`SELECT set_config('test.role','service_role',false); SELECT public.finish_bob_document_auto_review('${changedClaim}','approved','source_verified','${reviewers}'::jsonb,'${invoiceSourceClaims}'::jsonb,NULL,NULL,${verification(changedClaim)}, (SELECT lease_token FROM public.bob_document_auto_review_receipts WHERE id='${changedClaim}'));`);
    sql(`UPDATE public.document_promotion_proposals SET proposed_payload=proposed_payload-'due_date' WHERE id='${changedProposalId}'`);
    const changedApplication = JSON.parse(sql(`SELECT set_config('test.role','service_role',false); SELECT public.apply_bob_document_auto_proposal('${changedClaim}');`).split('\n').at(-1));
    assert.equal(changedApplication.status, 'blocked');
    assert.match(changedApplication.reason, /changed after review/);
    assert.equal(sql('SELECT count(*) FROM public.invoices'), '1');
    assert.equal(sql(`SELECT recipient_user_id='33333333-3333-4333-8333-333333333333' AND link_payload->>'document_id'='${invoiceDocumentId}' AND link_page='document-studio' FROM public.test_notifications WHERE link_payload->>'version_id'='${invoiceVersionId}'`), 't');

    for (const currency of ['USD', null]) {
      const currencyProposalId = randomUUID();
      const payloadExpression = currency ? `jsonb_set(proposed_payload,'{currency}','"USD"')` : `proposed_payload-'currency'`;
      sql(`INSERT INTO public.document_promotion_proposals(id,organization_id,document_version_id,target_type,proposed_payload,status,requested_by)
        SELECT '${currencyProposalId}',organization_id,document_version_id,target_type,${payloadExpression},'proposed',requested_by FROM public.document_promotion_proposals WHERE id='${invoiceProposalId}'`);
      const currencyClaim = sql(`SELECT set_config('test.role','service_role',false); SELECT receipt_id FROM public.claim_bob_document_auto_review('${invoiceVersionId}','promotion','${currencyProposalId}','${invoiceHash}');`).split('\n').at(-1);
      const currencyClaims = invoiceFields.filter(([field]) => field !== 'currency').map(([field, value, quote]) => makeSourceClaim(invoiceSource, field, value, quote));
      if (currency) currencyClaims.push(makeSourceClaim(invoiceSource, 'currency', currency, 'Alternative currency: USD'));
      sql(`SELECT set_config('test.role','service_role',false); SELECT public.finish_bob_document_auto_review('${currencyClaim}','approved','source_verified','${reviewers}'::jsonb,'${JSON.stringify(currencyClaims)}'::jsonb,NULL,NULL,${verification(currencyClaim)}, (SELECT lease_token FROM public.bob_document_auto_review_receipts WHERE id='${currencyClaim}'));`);
      const currencyApplication = JSON.parse(sql(`SELECT set_config('test.role','service_role',false); SELECT public.apply_bob_document_auto_proposal('${currencyClaim}');`).split('\n').at(-1));
      assert.equal(currencyApplication.status, 'blocked');
      assert.match(currencyApplication.reason, /NZD currency/);
    }
    assert.equal(sql('SELECT count(*) FROM public.invoices'), '1');

    assert.throws(() => sql(`SELECT set_config('test.role','authenticated',false); SELECT * FROM public.claim_bob_document_auto_review('${blockedVersion}','classification',NULL,'${'c'.repeat(64)}');`));
  } finally {
    if (created) { try { docker(['rm', '-f', container]); } catch {} }
  }
});