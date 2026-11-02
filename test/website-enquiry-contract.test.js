const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

const root = resolve(__dirname, '..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const migration = read('supabase/migrations/20261103110000_website_enquiries.sql');
const indexSource = read('supabase/functions/website-enquiry/index.ts');
const handlerSource = read('supabase/functions/website-enquiry/handler.mjs');
const config = read('supabase/config.toml');

const SUBMIT_SIGNATURE = 'public.submit_website_enquiry(text, text, boolean, text, text, text, text, text, text[], text, text)';
const REVIEW_SIGNATURE = 'public.review_website_enquiry(uuid, text, text, integer)';
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const loadModules = async () => {
  const dir = resolve(root, 'supabase/functions/website-enquiry');
  const validate = await import(pathToFileURL(resolve(dir, 'validate.mjs')).href);
  const handler = await import(pathToFileURL(resolve(dir, 'handler.mjs')).href);
  const notify = await import(pathToFileURL(resolve(dir, 'notify.mjs')).href);
  return { ...validate, ...handler, ...notify };
};

const functionBody = (name) => {
  const start = migration.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  assert.notEqual(start, -1, `${name} is defined`);
  const end = migration.indexOf('$function$;', start);
  return migration.slice(start, end);
};

const validEnquiry = (overrides = {}) => ({
  name: '  Ana Smith  ',
  email: 'ana@example.com',
  phone: '+64 (9) 555-0100',
  organisation: 'Example Farms',
  location: 'Taupo',
  services: ['raptor', 'patrols-response', 'raptor'],
  message: 'Please quote for overnight patrols at our yard.',
  preferred_contact: 'phone',
  privacy_ack: true,
  source_page: '/contact',
  website: '',
  started_at: 1_000_000,
  ...overrides,
});

const makeHandler = async ({ result = { data: 'ENQ-1A2B3C', error: null }, now = 1_000_000 + 60_000, notify, background } = {}) => {
  const { createWebsiteEnquiryHandler } = await loadModules();
  const calls = [];
  const logs = [];
  const handle = createWebsiteEnquiryHandler({
    submit: async (args) => {
      calls.push(args);
      return result;
    },
    salt: async () => 'test-salt',
    now: () => now,
    logError: (message, detail) => logs.push({ message, detail }),
    ...(notify ? { notify } : {}),
    ...(background ? { background } : {}),
  });
  return { handle, calls, logs };
};

const post = (body, headers = {}) => new Request('https://example.supabase.co/functions/v1/website-enquiry', {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

test('website_enquiries table is RLS-protected, admin-readable and never anon-granted', () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.website_enquiries \(/);
  assert.match(migration, /ALTER TABLE public\.website_enquiries ENABLE ROW LEVEL SECURITY;/);
  assert.match(migration, /REVOKE ALL ON TABLE public\.website_enquiries FROM PUBLIC, anon, authenticated;/);
  assert.match(migration, /GRANT SELECT ON TABLE public\.website_enquiries TO authenticated;/);
  assert.match(migration, /GRANT ALL ON TABLE public\.website_enquiries TO service_role;/);
  assert.doesNotMatch(migration, /GRANT [^;]*ON TABLE public\.website_enquiries TO [^;]*\banon\b/);
  assert.doesNotMatch(migration, /GRANT (INSERT|UPDATE|DELETE|ALL)[^;]*ON TABLE public\.website_enquiries TO [^;]*\bauthenticated\b/);
  assert.doesNotMatch(migration, /CREATE POLICY[^;]*ON public\.website_enquiries\s+FOR (INSERT|UPDATE|DELETE|ALL)/);
  assert.match(migration, /FOR SELECT TO authenticated\s+USING \(\s*\(\( SELECT public\.is_grand_master\(\)\)\)\s+OR \(\( SELECT public\.is_admin_for_org\(provider_organization_id\)\)\)\s*\);/);
  assert.match(migration, /\(provider_organization_id, status, received_at DESC\)/);
  assert.match(migration, /\(client_hash, received_at\)/);
  assert.match(migration, /CHECK \(privacy_ack\)/);
  assert.match(migration, /CHECK \(status IN \('new', 'contacted', 'converted', 'closed', 'spam'\)\)/);
});

test('submit_website_enquiry is service-role only and resolves the provider server-side', () => {
  const body = functionBody('submit_website_enquiry');
  assert.match(body, /SECURITY DEFINER\s+SET search_path = ''/);
  assert.match(body, /FROM private\.platform_tenancy t\s+WHERE t\.singleton/);
  assert.doesNotMatch(body, /p_provider|p_organization_id uuid/);
  assert.match(body, /ERRCODE = 'PT429', MESSAGE = 'website_enquiry_rate_limited'/);
  assert.match(body, /v_recent >= 5/);
  assert.match(body, /interval '1 hour'/);
  assert.match(body, /pg_advisory_xact_lock/);
  assert.match(body, /'ENQ-' \|\| upper\(substr\(replace\(v_id::text, '-', ''\), 1, 6\)\)/);
  assert.match(body, /EXCEPTION WHEN OTHERS THEN\s+RAISE WARNING 'website enquiry % notification failed/);
  assert.match(migration, new RegExp(`REVOKE ALL ON FUNCTION ${escape(SUBMIT_SIGNATURE)} FROM PUBLIC, anon, authenticated;`));
  assert.match(migration, new RegExp(`GRANT EXECUTE ON FUNCTION ${escape(SUBMIT_SIGNATURE)} TO service_role;`));
  const submitGrants = migration.match(new RegExp(`GRANT EXECUTE ON FUNCTION ${escape(SUBMIT_SIGNATURE)} TO [^;]+;`, 'g'));
  assert.deepEqual(submitGrants, [`GRANT EXECUTE ON FUNCTION ${SUBMIT_SIGNATURE} TO service_role;`]);
});

test('review_website_enquiry authenticates, checks reach and version, and audits', () => {
  const body = functionBody('review_website_enquiry');
  assert.match(body, /SECURITY DEFINER\s+SET search_path = ''/);
  assert.match(body, /v_uid uuid := auth\.uid\(\);/);
  assert.match(body, /IF v_uid IS NULL THEN/);
  assert.match(body, /public\.is_grand_master\(\) OR public\.is_admin_for_org\(v_provider\)/);
  assert.match(body, /FOR UPDATE;/);
  assert.match(body, /'This enquiry was changed by someone else\. Reload and try again\.' USING ERRCODE = 'PT409'/);
  assert.match(body, /v_status IN \('converted', 'closed', 'spam'\)/);
  assert.match(body, /version = e\.version \+ 1/);
  assert.match(body, /INSERT INTO public\.audit_log\(organization_id, actor_user_id, action, target_table, target_id, metadata\)/);
  assert.match(body, /'website_enquiry_reviewed', 'website_enquiries'/);
  assert.match(migration, new RegExp(`REVOKE ALL ON FUNCTION ${escape(REVIEW_SIGNATURE)} FROM PUBLIC, anon;`));
  assert.match(migration, new RegExp(`GRANT EXECUTE ON FUNCTION ${escape(REVIEW_SIGNATURE)} TO authenticated, service_role;`));
  assert.doesNotMatch(migration, new RegExp(`GRANT EXECUTE ON FUNCTION ${escape(REVIEW_SIGNATURE)} TO [^;]*\\banon\\b`));
});

test('migration passes the release lane destructive-statement gate', () => {
  for (const line of migration.split(/\r?\n/)) {
    assert.doesNotMatch(line, /^\s*(drop\s+(table|schema|database|column)|truncate\s+table|alter\s+table[^;]*\bdrop\b|delete\s+from\s+\S+\s*;)/i, line);
  }
});

test('config.toml deploys website-enquiry without JWT verification', () => {
  assert.match(config, /\[functions\.website-enquiry\]\r?\nverify_jwt = false/);
});

test('edge function stays self-contained and writes enquiries only through the service-role RPC', () => {
  const notifySource = read('supabase/functions/website-enquiry/notify.mjs');
  assert.doesNotMatch(indexSource + handlerSource + notifySource, /_shared/);
  assert.match(indexSource, /from '\.\/handler\.mjs'/);
  assert.match(indexSource, /rpc\('submit_website_enquiry', args\)/);
  assert.match(indexSource, /Deno\.env\.get\('WEBSITE_ENQUIRY_SALT'\)/);
  assert.match(indexSource, /sha256Hex\(key\)/);
  assert.doesNotMatch(handlerSource + notifySource, /\.from\(['"]/);
  // The only direct table access is the alert's read-only lookup by reference.
  const enquiryAccess = indexSource.match(/\.from\(['"]website_enquiries['"]\)\s*\.\w+\(/g) ?? [];
  assert.deepEqual(enquiryAccess.map((access) => access.replace(/\s+/g, '')), [".from('website_enquiries').select("]);
  assert.match(indexSource, /\.select\('id, provider_organization_id'\)\s*\.eq\('reference', reference\)\s*\.maybeSingle\(\)/);
});

test('allowed origins match the published contract', async () => {
  const { isAllowedOrigin, VERCEL_ORIGIN, classifyOrigin } = await loadModules();
  assert.equal(VERCEL_ORIGIN.source, '^https:\\/\\/randmsecurity-website(-[a-z0-9-]+)?\\.vercel\\.app$');
  for (const origin of [
    'https://randmsecurity.com',
    'https://www.randmsecurity.com',
    'https://randmsecurity-website.vercel.app',
    'https://randmsecurity-website-git-main-don.vercel.app',
    'http://localhost:4321',
    'http://127.0.0.1:4321',
  ]) assert.equal(isAllowedOrigin(origin), true, origin);
  for (const origin of [
    'http://randmsecurity.com',
    'https://randmsecurity.com.evil.example',
    'https://evil-randmsecurity-website.vercel.app',
    'https://randmsecurity-website-x.vercel.app.evil.example',
    'https://randmsecurity-website_X.vercel.app',
    'http://localhost:3000',
    'null',
    '',
  ]) assert.equal(isAllowedOrigin(origin), false, origin);
  assert.equal(classifyOrigin(null), 'none');
  assert.equal(classifyOrigin('https://evil.example'), 'denied');
});

test('boot probe: POST {} with no Origin returns the 400 validation response', async () => {
  const { handle, calls } = await makeHandler();
  const response = await handle(post({}));
  assert.equal(response.status, 400);
  assert.equal(response.headers.get('vary'), 'Origin');
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.error, 'validation');
  assert.deepEqual(Object.keys(body.fields).sort(), ['email', 'message', 'name', 'phone', 'privacy_ack']);
  assert.equal(calls.length, 0);
});

test('honeypot and too-fast submissions are silently dropped', async () => {
  const { handle, calls } = await makeHandler();
  for (const body of [
    validEnquiry({ website: 'https://spam.example' }),
    { website: 'filled' },
    validEnquiry({ started_at: 1_000_000 + 60_000 - 2_999 }),
  ]) {
    const response = await handle(post(body, { origin: 'https://randmsecurity.com' }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, reference: null });
    assert.equal(response.headers.get('access-control-allow-origin'), 'https://randmsecurity.com');
  }
  assert.equal(calls.length, 0);

  const slowEnough = await handle(post(validEnquiry({ started_at: 1_000_000 + 60_000 - 3_000 })));
  assert.equal(slowEnough.status, 200);
  const clockAhead = await handle(post(validEnquiry({ started_at: 1_000_000 + 120_000 })));
  assert.equal(clockAhead.status, 200);
  assert.equal(calls.length, 2);
});

test('valid enquiry is submitted once with trimmed fields, de-duplicated services and a salted IP hash', async () => {
  const { handle, calls } = await makeHandler();
  const response = await handle(post(validEnquiry(), {
    origin: 'https://randmsecurity-website-git-preview.vercel.app',
    'x-forwarded-for': '203.0.113.9, 10.0.0.1',
    apikey: 'anon-key',
    authorization: 'Bearer anon-key',
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, reference: 'ENQ-1A2B3C' });
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://randmsecurity-website-git-preview.vercel.app');
  assert.equal(calls.length, 1);
  const args = calls[0];
  assert.equal(args.p_name, 'Ana Smith');
  assert.deepEqual(args.p_services, ['raptor', 'patrols-response']);
  assert.equal(args.p_preferred_contact, 'phone');
  assert.equal(args.p_privacy_ack, true);
  assert.equal(args.p_source_page, '/contact');
  assert.match(args.p_client_hash, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(args), /203\.0\.113\.9/);
  const { hashClient } = await loadModules();
  assert.equal(args.p_client_hash, await hashClient('203.0.113.9', 'test-salt'));
  assert.equal(Object.keys(args).some((key) => /organi[sz]ation_id|provider/.test(key)), false);
});

test('origin, method, size and JSON errors follow the contract', async () => {
  const { handle, calls } = await makeHandler();

  const denied = await handle(post(validEnquiry(), { origin: 'https://evil.example' }));
  assert.equal(denied.status, 403);
  assert.deepEqual(await denied.json(), { ok: false, error: 'origin' });

  const preflight = await handle(new Request('https://x/functions/v1/website-enquiry', { method: 'OPTIONS', headers: { origin: 'https://www.randmsecurity.com' } }));
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://www.randmsecurity.com');
  assert.match(preflight.headers.get('access-control-allow-headers'), /apikey/);
  assert.match(preflight.headers.get('access-control-allow-headers'), /authorization/);
  assert.equal(preflight.headers.get('vary'), 'Origin');

  const deniedPreflight = await handle(new Request('https://x/', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } }));
  assert.equal(deniedPreflight.status, 403);

  const get = await handle(new Request('https://x/', { method: 'GET' }));
  assert.equal(get.status, 405);

  const declaredTooLarge = await handle(post('{}', { 'content-length': String(16 * 1024 + 1) }));
  assert.equal(declaredTooLarge.status, 413);

  const streamedTooLarge = await handle(new Request('https://x/', {
    method: 'POST',
    body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(`{"message":"${'x'.repeat(16 * 1024)}"}`)); controller.close(); } }),
    duplex: 'half',
  }));
  assert.equal(streamedTooLarge.status, 413);

  const atLimit = JSON.stringify(validEnquiry({ message: 'x'.repeat(4000) }));
  assert.ok(Buffer.byteLength(atLimit) <= 16 * 1024);
  const accepted = await handle(post(atLimit));
  assert.equal(accepted.status, 200);

  const badJson = await handle(post('{nope'));
  assert.equal(badJson.status, 400);
  assert.deepEqual((await badJson.json()).fields, { body: 'Send the enquiry as JSON.' });

  const notObject = await handle(post('[]'));
  assert.equal(notObject.status, 400);
  assert.equal(calls.length, 1);
});

test('field validation returns plain-English messages per field', async () => {
  const { validateEnquiry } = await loadModules();
  const result = validateEnquiry(validEnquiry({
    name: 'A',
    email: 'not-an-email',
    phone: '021 555 abc',
    organisation: 'x'.repeat(161),
    location: 'y'.repeat(161),
    services: ['raptor', 'drones'],
    message: 'too short',
    preferred_contact: 'fax',
    privacy_ack: 'yes',
    source_page: '/'.repeat(201),
  }));
  assert.equal(result.ok, false);
  assert.deepEqual(Object.keys(result.fields).sort(), [
    'email', 'location', 'message', 'name', 'organisation', 'phone', 'preferred_contact', 'privacy_ack', 'services', 'source_page',
  ]);
  for (const message of Object.values(result.fields)) assert.match(message, /^[A-Z][^{}<>]+\.$/);

  const phoneOnly = validateEnquiry(validEnquiry({ email: '', preferred_contact: undefined }));
  assert.equal(phoneOnly.ok, true);
  assert.equal(phoneOnly.enquiry.email, null);
  assert.equal(phoneOnly.enquiry.preferred_contact, 'either');
  assert.equal(validateEnquiry(validEnquiry({ email: 'a@b.co', phone: null })).ok, true);
  assert.equal(validateEnquiry(validEnquiry({ message: 'x'.repeat(4001) })).ok, false);
  assert.equal(validateEnquiry(validEnquiry({ name: 'x'.repeat(121) })).ok, false);
  assert.equal(validateEnquiry(validEnquiry({ email: `${'a'.repeat(195)}@b.com` })).ok, false);
  assert.equal(validateEnquiry(validEnquiry({ phone: '1'.repeat(41) })).ok, false);
});

test('database errors map to 429, 400 or a 500 that never leaks the cause', async () => {
  const limited = await makeHandler({ result: { data: null, error: { code: 'PT429', message: 'website_enquiry_rate_limited' } } });
  const rateLimited = await limited.handle(post(validEnquiry()));
  assert.equal(rateLimited.status, 429);
  assert.deepEqual(await rateLimited.json(), { ok: false, error: 'rate_limited' });

  const invalid = await makeHandler({ result: { data: null, error: { code: '22023', message: 'website_enquiry_invalid:name' } } });
  const invalidResponse = await invalid.handle(post(validEnquiry()));
  assert.equal(invalidResponse.status, 400);
  assert.deepEqual(Object.keys((await invalidResponse.json()).fields), ['name']);

  const broken = await makeHandler({ result: { data: null, error: { code: '42P01', message: 'relation "public.website_enquiries" does not exist' } } });
  const failure = await broken.handle(post(validEnquiry(), { origin: 'https://randmsecurity.com' }));
  assert.equal(failure.status, 500);
  const text = await failure.text();
  assert.deepEqual(JSON.parse(text), { ok: false, error: 'unavailable' });
  assert.doesNotMatch(text, /relation|website_enquiries|42P01/);
  assert.equal(broken.logs.length, 1);

  const noReference = await makeHandler({ result: { data: null, error: null } });
  assert.equal((await noReference.handle(post(validEnquiry()))).status, 500);
});

test('rate-limit identity prefers the proxy-set client address over a spoofable forwarded chain', async () => {
  const { clientIpFromHeaders } = await loadModules();
  const headers = (init) => new Headers(init);
  assert.equal(clientIpFromHeaders(headers({ 'cf-connecting-ip': '198.51.100.7', 'x-forwarded-for': '1.2.3.4, 198.51.100.7' })), '198.51.100.7');
  assert.equal(clientIpFromHeaders(headers({ 'x-forwarded-for': '203.0.113.9, 10.0.0.1' })), '203.0.113.9');
  assert.equal(clientIpFromHeaders(headers({ 'x-real-ip': '192.0.2.4' })), '192.0.2.4');
  assert.equal(clientIpFromHeaders(headers({})), 'unknown');

  const comment = read('supabase/migrations/20261103120100_website_enquiry_client_hash_comment.sql');
  assert.match(comment, /COMMENT ON COLUMN public\.website_enquiries\.client_hash IS\s+'[^']*CF-Connecting-IP, else the first X-Forwarded-For entry, else X-Real-IP/);
});

test('email alerts go to the R&M inbox by default and accept only plain configured addresses', async () => {
  const { DEFAULT_ALERT_RECIPIENTS, resolveAlertRecipients } = await loadModules();
  assert.deepEqual([...DEFAULT_ALERT_RECIPIENTS], ['admin@remsec.co.nz', 'don@remsec.co.nz']);
  assert.deepEqual(resolveAlertRecipients(undefined), ['admin@remsec.co.nz', 'don@remsec.co.nz']);
  assert.deepEqual(resolveAlertRecipients('   '), ['admin@remsec.co.nz', 'don@remsec.co.nz']);
  assert.deepEqual(resolveAlertRecipients('nope, also bad@, "x" <y@z.nz>'), ['admin@remsec.co.nz', 'don@remsec.co.nz']);
  assert.deepEqual(
    resolveAlertRecipients(' Ops@RemSec.co.nz; don@remsec.co.nz ,ops@remsec.co.nz,bad\r\nbcc:evil@example.com'),
    ['ops@remsec.co.nz', 'don@remsec.co.nz'],
  );
});

test('every allowed service has an alert label and the subject never carries visitor text', async () => {
  const { ALLOWED_SERVICES, SERVICE_LABELS, buildEnquiryAlert, validateEnquiry } = await loadModules();
  assert.deepEqual(Object.keys(SERVICE_LABELS).sort(), [...ALLOWED_SERVICES].sort());
  for (const label of Object.values(SERVICE_LABELS)) assert.match(label, /^[ -~]+$/);

  const parsed = validateEnquiry(validEnquiry({
    name: 'Ana\r\nBcc: evil@example.com',
    organisation: 'Farm\u2028Ltd',
    message: 'Line one.\r\n.\r\nQUIT\nLine three.',
  }));
  assert.equal(parsed.ok, true);
  const alert = buildEnquiryAlert({
    reference: 'ENQ-1A2B3C',
    enquiry: parsed.enquiry,
    receivedAt: new Date('2026-11-02T01:00:00Z'),
    reviewUrl: 'https://fcmanager.co.nz',
  });
  assert.equal(alert.subject, 'Website enquiry ENQ-1A2B3C: Raptor mobile surveillance +1');
  assert.doesNotMatch(alert.subject, /[\r\n]/);
  assert.equal(alert.replyTo, 'ana@example.com');
  assert.equal(alert.invalidReviewUrl, false);
  assert.match(alert.text, /^Name: Ana Bcc: evil@example\.com$/m);
  assert.doesNotMatch(alert.text, /^Bcc:/m);
  assert.match(alert.text, /^Organisation: Farm Ltd$/m);
  assert.match(alert.text, /^Services: Raptor mobile surveillance; Security patrols and alarm response$/m);
  assert.match(alert.text, /^Phone: \+64 \(9\) 555-0100$/m);
  assert.match(alert.text, /^Preferred contact: Phone$/m);
  assert.match(alert.text, /Message:\nLine one\.\n\.\nQUIT\nLine three\.\n/);
  assert.match(alert.text, /CRM > Website enquiries/);
  assert.match(alert.text, /^https:\/\/fcmanager\.co\.nz$/m);
  assert.match(alert.html, /Field Compliance Manager/);
  assert.match(alert.html, /alt="Iron Eagle Security"/);
  assert.match(alert.html, /Line one\.<br>\.<br>QUIT<br>Line three\./);
  assert.match(alert.html, /href="https:\/\/fcmanager\.co\.nz\/"/);

  const phoneOnly = validateEnquiry(validEnquiry({ email: '', services: [] }));
  assert.equal(phoneOnly.ok, true);
  const quiet = buildEnquiryAlert({ reference: 'ENQ-ABCDEF', enquiry: phoneOnly.enquiry, receivedAt: new Date(0) });
  assert.equal(quiet.subject, 'Website enquiry ENQ-ABCDEF');
  assert.equal(quiet.replyTo, null);
  assert.match(quiet.text, /^Email: Not given$/m);
  assert.match(quiet.text, /^Services: Not chosen$/m);
  assert.match(quiet.html, /Email<\/th>\s*<td[^>]*>Not given<\/td>/);
  assert.match(quiet.html, /Services<\/th>\s*<td[^>]*>Not chosen<\/td>/);
  assert.doesNotMatch(quiet.html, /Replying to this email goes/);
});

test('branded HTML escapes enquiry values while retaining the plain-text details', async () => {
  const { buildEnquiryAlert, validateEnquiry } = await loadModules();
  const parsed = validateEnquiry(validEnquiry());
  assert.equal(parsed.ok, true);
  const enquiry = {
    ...parsed.enquiry,
    name: `Ana <img src=x onerror="alert('x')">`,
    email: '"person"@example.com',
    phone: '+64 <test>',
    organisation: `R&M "Test" <script>alert('a')</script>`,
    location: `A & B <svg onload="alert(1)">`,
    source_page: '/<img src=x>',
    message: 'Hello <script>alert("x")</script>\r\nNext & last\n.\nQUIT',
  };
  const alert = buildEnquiryAlert({
    reference: 'ENQ-1A2B3C',
    enquiry,
    receivedAt: new Date('2026-11-02T01:00:00Z'),
    reviewUrl: 'https://fcmanager.co.nz/?tab=crm&label=%22safe%22',
  });

  assert.equal(alert.replyTo, null);
  assert.match(alert.text, /Name: Ana <img src=x onerror="alert\('x'\)">/);
  assert.match(alert.text, /Message:\nHello <script>alert\("x"\)<\/script>\nNext & last\n\.\nQUIT/);
  assert.match(alert.html, /Ana &lt;img src=x onerror=&quot;alert\(&#39;x&#39;\)&quot;&gt;/);
  assert.match(alert.html, /&quot;person&quot;@example\.com/);
  assert.match(alert.html, /\+64 &lt;test&gt;/);
  assert.match(alert.html, /R&amp;M &quot;Test&quot; &lt;script&gt;alert\(&#39;a&#39;\)&lt;\/script&gt;/);
  assert.match(alert.html, /A &amp; B &lt;svg onload=&quot;alert\(1\)&quot;&gt;/);
  assert.match(alert.html, /\/&lt;img src=x&gt;/);
  assert.match(alert.html, /Hello &lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;<br>Next &amp; last<br>\.<br>QUIT/);
  assert.match(alert.html, /href="https:\/\/fcmanager\.co\.nz\/\?tab=crm&amp;label=%22safe%22"/);
  assert.doesNotMatch(alert.html, /<script\b|<svg\b|<img src=x|onload="|onerror="/i);
});

test('invalid configured review links are omitted without leaking credentials', async () => {
  const { buildEnquiryAlert, validateEnquiry } = await loadModules();
  const parsed = validateEnquiry(validEnquiry());
  assert.equal(parsed.ok, true);
  for (const reviewUrl of [
    'javascript:alert(1)',
    'https://user:secret@example.com/',
    'https://fcmanager.co.nz/" onclick="alert(1)',
    'not a URL',
  ]) {
    const alert = buildEnquiryAlert({ reference: 'ENQ-1A2B3C', enquiry: parsed.enquiry, receivedAt: new Date(0), reviewUrl });
    assert.equal(alert.invalidReviewUrl, true, reviewUrl);
    assert.match(alert.text, /Review link unavailable; ask an administrator to check SITE_URL\./);
    assert.match(alert.html, /Review link unavailable; ask an administrator to check SITE_URL\./);
    assert.ok(!alert.text.includes(reviewUrl));
    assert.ok(!alert.html.includes(reviewUrl));
    assert.doesNotMatch(alert.html, /href="(?:javascript:|https:\/\/user:)/);
    assert.doesNotMatch(alert.text + alert.html, /secret@example\.com/);
  }
});

test('both MIME alternatives are base64 so visitor text cannot end SMTP DATA', async () => {
  const { buildAlertMimeContent, encodeBase64Body } = await loadModules();
  const text = `Kia ora.\n.\n${'x'.repeat(73)}.\nQUIT\n`;
  const html = `<html><body>Kia ora &amp; welcome<br>\n.\n${'y'.repeat(73)}.\nQUIT</body></html>`;
  const parts = buildAlertMimeContent({ text, html });
  assert.deepEqual(parts.map(({ mimeType, transferEncoding }) => ({ mimeType, transferEncoding })), [
    { mimeType: 'text/plain; charset="utf-8"', transferEncoding: 'base64' },
    { mimeType: 'text/html; charset="utf-8"', transferEncoding: 'base64' },
  ]);
  for (const [index, original] of [text, html].entries()) {
    const body = parts[index].content;
    assert.doesNotMatch(body, /\./);
    for (const line of body.split('\r\n')) assert.ok(line.length <= 76, line);
    assert.doesNotMatch(body.replace(/\r\n/g, ''), /[\r\n]/);
    assert.equal(Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8'), original.replace(/\n/g, '\r\n'));
  }
  assert.equal(encodeBase64Body(''), '');
});

test('the email alert runs once, only after the enquiry is stored, and never changes the response', async () => {
  const sent = [];
  const notify = async (alert) => { sent.push(alert); };
  const ok = await makeHandler({ notify });
  const response = await ok.handle(post(validEnquiry(), { origin: 'https://randmsecurity.com' }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, reference: 'ENQ-1A2B3C' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].reference, 'ENQ-1A2B3C');
  assert.equal(sent[0].enquiry.name, 'Ana Smith');
  assert.deepEqual(sent[0].enquiry.services, ['raptor', 'patrols-response']);
  assert.equal(sent[0].receivedAt.getTime(), 1_000_000 + 60_000);

  await ok.handle(post(validEnquiry({ website: 'spam' })));
  await ok.handle(post({}));
  assert.equal(sent.length, 1);

  for (const result of [
    { data: null, error: { code: 'PT429', message: 'website_enquiry_rate_limited' } },
    { data: null, error: { code: '42P01', message: 'boom' } },
    { data: null, error: null },
  ]) {
    const failed = await makeHandler({ result, notify });
    await failed.handle(post(validEnquiry()));
  }
  assert.equal(sent.length, 1);
});

test('a failed email alert is logged without enquiry details and the lead is still accepted', async () => {
  const failing = await makeHandler({ notify: async () => { throw new Error('SMTP 535 authentication failed'); } });
  const response = await failing.handle(post(validEnquiry()));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, reference: 'ENQ-1A2B3C' });
  assert.equal(failing.logs.length, 1);
  assert.equal(failing.logs[0].message, 'website-enquiry: email alert failed');
  assert.deepEqual(failing.logs[0].detail, { reference: 'ENQ-1A2B3C', error: 'SMTP 535 authentication failed' });
  assert.doesNotMatch(JSON.stringify(failing.logs), /Ana|ana@example|555-0100|overnight patrols/);
});

test('with a background runner the response does not wait for the email alert', async () => {
  let release;
  const gate = new Promise((resolveGate) => { release = resolveGate; });
  const tasks = [];
  let finished = false;
  const { handle } = await makeHandler({
    notify: async () => { await gate; finished = true; },
    background: (task) => { tasks.push(task); },
  });
  const response = await handle(post(validEnquiry()));
  assert.equal(response.status, 200);
  assert.equal(tasks.length, 1);
  assert.equal(finished, false);
  release();
  await tasks[0];
  assert.equal(finished, true);

  let awaited = false;
  const fallback = await makeHandler({
    notify: async () => { awaited = true; },
    background: () => { throw new Error('EdgeRuntime.waitUntil unavailable'); },
  });
  assert.equal((await fallback.handle(post(validEnquiry()))).status, 200);
  assert.equal(awaited, true);
});

test('Deno wiring sends over SMTP on an allowed port and audits every alert outcome', () => {
  assert.match(indexSource, /import \{ SMTPClient \} from 'https:\/\/deno\.land\/x\/denomailer@1\.6\.0\/mod\.ts';/);
  assert.match(indexSource, /resolveAlertRecipients\(Deno\.env\.get\('WEBSITE_ENQUIRY_NOTIFY_TO'\)\)/);
  assert.match(indexSource, /const BLOCKED_SMTP_PORTS = new Set\(\[25, 587\]\);/);
  assert.match(indexSource, /Deno\.env\.get\('SMTP_PORT'\)\?\.trim\(\) \|\| '465'/);
  assert.match(indexSource, /mimeContent: buildAlertMimeContent\(message\)/);
  assert.match(indexSource, /if \(message\.invalidReviewUrl\)/);
  assert.doesNotMatch(indexSource, /\bcontent: message\.(?:text|html)\b|\bhtml:/);
  assert.match(indexSource, /action: 'website_enquiry_email_alert'/);
  assert.match(indexSource, /target_table: 'website_enquiries'/);
  for (const reason of ['smtp_not_configured', 'smtp_port_blocked', 'smtp_timeout', 'smtp_error']) {
    assert.match(indexSource, new RegExp(`reason: [^\\n]*'${reason}'`), reason);
  }
  assert.match(indexSource, /result: 'sent'/);
  assert.match(indexSource, /notify: sendEnquiryAlert,\s*background: backgroundTask,/);
  assert.match(indexSource, /EdgeRuntime/);
  assert.doesNotMatch(indexSource, /metadata: \{[^}]*(name|email|phone|message)/);
});
