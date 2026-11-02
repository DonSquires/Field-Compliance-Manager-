const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const migration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261104120000_website_news_publishing.sql'), 'utf8');

test('website posts keep published snapshots separate and forbid anonymous draft access', () => {
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /REVOKE ALL ON TABLE public.website_posts FROM PUBLIC, anon, authenticated, service_role/);
  assert.match(migration, /AS RESTRICTIVE FOR ALL TO anon/);
  assert.match(migration, /AS RESTRICTIVE FOR UPDATE TO authenticated/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public.read_published_website_posts\(text, uuid\) TO service_role/);
  assert.match(migration, /ELSE published_content END/);
  assert.match(migration, /INSERT INTO public.audit_log/);
});

test('website drafts, publication, retry recovery, photos and tenant isolation work in PostgreSQL', {
  skip: process.env.BOB_TEST_POSTGRES !== '1', timeout: 60000,
}, async () => {
  const container = `fcm-website-posts-${randomUUID()}`;
  const docker = (args, options = {}) => execFileSync('docker', args, {
    encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...options,
  });
  const sql = input => docker(['exec', '-i', container, 'psql', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres'], { input }).trim();
  const org = '00000000-0000-4000-8000-000000000001';
  const otherOrg = '00000000-0000-4000-8000-000000000002';
  const actor = '00000000-0000-4000-8000-000000000010';
  const stranger = '00000000-0000-4000-8000-000000000020';
  const post = '00000000-0000-4000-8000-000000000030';
  const photo = `${org}/${post}/00000000-0000-4000-8000-000000000040.jpg`;
  const asAdmin = query => sql(`SET ROLE authenticated; SET request.jwt.claim.sub='${actor}'; ${query}`);
  const action = (version, request, name, title = 'Urban patrol update', body = 'Public update text.', image = 'NULL', alt = '') =>
    `SELECT public.manage_website_post('${post}',${version},'${request}','${name}','${title}','','${body}',${image},'${alt}');`;
  let created = false;
  try {
    docker(['run', '--detach', '--name', container, '--network', 'none',
      '--mount', 'type=tmpfs,destination=/var/lib/postgresql/data',
      '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgis/postgis:17-3.5']);
    created = true;
    let ready = false;
    for (let i = 0; i < 120; i++) {
      try { docker(['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']); ready = true; break; }
      catch { await new Promise(resolve => setTimeout(resolve, 250)); }
    }
    assert.ok(ready, 'Disposable PostgreSQL ready');
    sql(`
      CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
      CREATE SCHEMA auth; GRANT USAGE ON SCHEMA auth TO PUBLIC;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
        SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
      $$;
      CREATE TABLE public.organizations(id uuid PRIMARY KEY);
      INSERT INTO public.organizations VALUES ('${org}'),('${otherOrg}');
      CREATE TABLE public.user_profiles(id uuid PRIMARY KEY, organization_id uuid, active boolean NOT NULL);
      INSERT INTO public.user_profiles VALUES ('${actor}','${org}',true),('${stranger}','${otherOrg}',true);
      CREATE SCHEMA private;
      CREATE TABLE private.platform_tenancy(singleton boolean, service_provider_organization_id uuid);
      INSERT INTO private.platform_tenancy VALUES (true,'${org}');
      CREATE FUNCTION public.is_grand_master() RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
      CREATE FUNCTION public.is_admin_for_org(uuid) RETURNS boolean LANGUAGE sql SECURITY DEFINER AS $$
        SELECT EXISTS(SELECT 1 FROM public.user_profiles WHERE id=auth.uid() AND organization_id=$1 AND active)
      $$;
      CREATE TABLE public.audit_log(organization_id uuid,actor_user_id uuid,action text,target_table text,target_id uuid,metadata jsonb);
      CREATE SCHEMA storage; GRANT USAGE ON SCHEMA storage TO anon,authenticated,service_role;
      CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
      CREATE TABLE storage.objects(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),bucket_id text,name text,metadata jsonb);
      ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
      GRANT SELECT,INSERT,UPDATE,DELETE ON storage.objects TO anon,authenticated,service_role;
      CREATE POLICY existing_broad_policy ON storage.objects FOR ALL TO anon,authenticated USING(true) WITH CHECK(true);
      CREATE FUNCTION storage.foldername(text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
        SELECT string_to_array(regexp_replace($1,'/[^/]+$',''),'/')
      $$;
    `);
    sql(migration);
    const request = randomUUID();
    const saved = JSON.parse(asAdmin(action(0, request, 'save')));
    assert.equal(saved.version, 1);
    assert.equal(saved.published_content, null);
    assert.equal(JSON.parse(asAdmin(action(0, request, 'save'))).version, 1, 'Same unchanged retry returns saved receipt');
    assert.equal(sql('SELECT count(*) FROM public.audit_log;'), '1');
    assert.throws(() => asAdmin(action(0, request, 'save', 'Changed request')), /request_reuse/);
    assert.equal(sql('SET ROLE service_role; SELECT public.read_published_website_posts();'), '[]', 'Draft never appears publicly');
    assert.throws(() => sql('SET ROLE anon; SELECT * FROM public.website_posts;'), /permission denied/);
    assert.throws(() => sql('SET ROLE anon; SELECT public.read_published_website_posts();'), /permission denied/);
    assert.throws(() => sql(`SET ROLE authenticated; SET request.jwt.claim.sub='${stranger}'; SELECT public.list_website_posts();`), /access_denied/);
    assert.throws(() => sql(`SET ROLE authenticated; SET request.jwt.claim.sub='${stranger}'; ${action(1, randomUUID(), 'publish')}`), /access_denied/);
    assert.throws(() => asAdmin(action(1, randomUUID(), 'publish', 'Urban patrol update', '')), /publish_content/);
    assert.throws(() => asAdmin(action(1, randomUUID(), 'publish', 'Urban patrol update', 'Fixed rate $50 per hour.')), /pricing_not_permitted/);
    assert.doesNotThrow(() => asAdmin(`BEGIN; ${action(1, randomUUID(), 'publish', 'Public liability cover', 'Our $10 million liability cover.')} ROLLBACK;`));
    asAdmin(`INSERT INTO storage.objects(bucket_id,name,metadata) VALUES('website-post-images','${photo}','{"mimetype":"image/jpeg","size":100}');`);
    assert.throws(() => sql(`SET ROLE anon; INSERT INTO storage.objects(bucket_id,name) VALUES('website-post-images','${photo}');`), /row-level security/);
    assert.equal(sql(`SET ROLE anon; SELECT count(*) FROM storage.objects WHERE bucket_id='website-post-images';`), '0');
    assert.equal(sql(`SET ROLE authenticated; SET request.jwt.claim.sub='${stranger}'; SELECT count(*) FROM storage.objects;`), '0');
    assert.throws(() => asAdmin(action(1, randomUUID(), 'publish', 'Urban patrol update', 'Text', `'${photo}'`)), /publish_content/);
    const publishRequest = randomUUID();
    const published = JSON.parse(asAdmin(action(1, publishRequest, 'publish', 'Urban patrol update', 'Public update text.', `'${photo}'`, 'Synthetic patrol vehicle')));
    assert.equal(published.version, 2);
    assert.equal(published.published_content.title, 'Urban patrol update');
    assert.ok(Number.isFinite(Date.parse(published.published_content.published_at)), 'Publication date is valid ISO');
    assert.equal(JSON.parse(asAdmin(action(1, publishRequest, 'publish', 'Urban patrol update', 'Public update text.', `'${photo}'`, 'Synthetic patrol vehicle'))).version, 2);
    const publicRows = JSON.parse(sql('SET ROLE service_role; SELECT public.read_published_website_posts();'));
    assert.equal(publicRows.length, 1);
    assert.equal(publicRows[0].photo_path, photo);
    assert.equal(publicRows[0].created_by, undefined);
    assert.equal(publicRows[0].last_request_payload, undefined);
    const draft = JSON.parse(asAdmin(action(2, randomUUID(), 'save', 'Private changed title', 'Not approved for publication.', `'${photo}'`, 'Private changed description')));
    assert.equal(draft.published_content.title, 'Urban patrol update', 'Saving never overwrites public copy');
    assert.equal(JSON.parse(sql('SET ROLE service_role; SELECT public.read_published_website_posts();'))[0].body, 'Public update text.');
    assert.equal(asAdmin(`WITH changed AS (UPDATE storage.objects SET metadata='{}' WHERE name='${photo}' RETURNING *) SELECT count(*) FROM changed;`), '0', 'Published image cannot be replaced through an existing permissive policy');
    assert.equal(asAdmin(`WITH removed AS (DELETE FROM storage.objects WHERE name='${photo}' RETURNING *) SELECT count(*) FROM removed;`), '0');
    assert.throws(() => asAdmin(action(2, randomUUID(), 'save')), /conflict/);
    const unpublished = JSON.parse(asAdmin(action(3, randomUUID(), 'unpublish', draft.title, draft.body)));
    assert.equal(unpublished.published_content, null);
    assert.equal(sql(`SET ROLE service_role; SELECT public.read_published_website_posts(NULL,'${post}');`), '[]', 'Unpublished photo lookup also vanishes');
    assert.equal(asAdmin(`SELECT count(*) FROM public.website_posts WHERE id='${post}';`), '1', 'Unpublish preserves the private draft');
    sql(`UPDATE public.user_profiles SET active=false WHERE id='${actor}';`);
    assert.throws(() => asAdmin('SELECT public.list_website_posts();'), /access_denied/);
    assert.throws(() => asAdmin(action(4, randomUUID(), 'publish')), /access_denied/);
    assert.equal(asAdmin('SELECT count(*) FROM storage.objects;'), '0');
    assert.equal(sql(`SELECT has_function_privilege('anon','public.manage_website_post(uuid,integer,uuid,text,text,text,text,text,text)','execute');`), 'f');
    assert.equal(sql(`SELECT has_function_privilege('authenticated','public.read_published_website_posts(text,uuid)','execute');`), 'f');
  } finally {
    if (created) docker(['rm', '-f', container]);
  }
});
