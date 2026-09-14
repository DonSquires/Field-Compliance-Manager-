#!/usr/bin/env node
// Read-only bridge to Bob's GitLab reader (bob-repo-search) using the dedicated
// grand_master test identity. Tokens are never printed; the GitLab token stays
// server-side inside the Edge Function.
import fs from 'node:fs';

const SUPABASE_URL = process.env.SUPABASE_URL;
const PROJECT_REF = new URL(SUPABASE_URL).hostname.split('.')[0];
const PAT = process.env.FIELD_COMPLIANCE_CODESPACE;
const EMAIL = process.env.GRANDMASTER_TEST_EMAIL;
const PASSWORD = process.env.GRANDMASTER_TEST_PASSWORD;
const CACHE = '/tmp/.fcm-gitlab-read-session.json';

async function anonKey() {
  const r = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/api-keys?reveal=false`, {
    headers: { Authorization: `Bearer ${PAT}` },
  });
  if (!r.ok) throw new Error(`api-keys ${r.status}`);
  const keys = await r.json();
  const anon = keys.find((k) => k.name === 'anon') ?? keys.find((k) => /anon/i.test(k.name));
  if (!anon?.api_key) throw new Error('anon key not found');
  return anon.api_key;
}

async function session() {
  try {
    const cached = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
    if (cached.expires_at - 60 > Date.now() / 1000) return cached;
  } catch {}
  const key = await anonKey();
  const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!r.ok) throw new Error(`login ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const data = await r.json();
  const s = { access_token: data.access_token, expires_at: data.expires_at, anon: key };
  fs.writeFileSync(CACHE, JSON.stringify(s), { mode: 0o600 });
  return s;
}

async function repo(body) {
  const s = await session();
  const r = await fetch(`${SUPABASE_URL}/functions/v1/bob-repo-search`, {
    method: 'POST',
    headers: { apikey: s.anon, Authorization: `Bearer ${s.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text.slice(0, 500) }; }
  return { status: r.status, ...parsed };
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === 'search') {
  const [query, limit = '50', ref] = args;
  const out = await repo({ action: 'search', query, limit: Number(limit), ...(ref ? { ref } : {}) });
  console.log(JSON.stringify({ status: out.status, search_status: out.status_note ?? out.status, note: out.note, count: out.count, term_status: out.term_status, error: out.error }, null, 0));
  for (const hit of out.results ?? []) console.log(`${hit.path}:${hit.startline}  ${String(hit.snippet).replace(/\s+/g, ' ').slice(0, 140)}`);
} else if (cmd === 'read') {
  const [path, start, end, ref] = args;
  const body = { action: 'read', path, ...(ref ? { ref } : {}) };
  if (start !== undefined) { body.start_line = Number(start); body.end_line = Number(end ?? Number(start) + 199); }
  const out = await repo(body);
  if (!out.ok) { console.log(JSON.stringify(out)); process.exit(1); }
  console.log(`# ${out.path} @ ${out.ref} lines ${out.start_line ?? 1}-${out.end_line ?? '?'} of ${out.total_lines ?? out.total_length} has_more=${out.has_more}`);
  console.log(out.content);
} else if (cmd === 'dump') {
  // Fetch whole files by paging line windows into $GITLAB_READ_OUT (default /tmp/gitlab-read)/<path>.
  const [ref, ...paths] = args;
  for (const path of paths) {
    let start = 1; const chunks = []; let total = null; let failed = null;
    for (let guard = 0; guard < 400; guard++) {
      const out = await repo({ action: 'read', path, start_line: start, end_line: start + 399, ...(ref && ref !== '-' ? { ref } : {}) });
      if (!out.ok) { failed = out.error ?? `HTTP ${out.status}`; break; }
      chunks.push(out.content); total = out.total_lines;
      if (!out.has_more) break;
      start = out.next_start_line;
    }
    if (failed) { console.log(`FAIL ${path}: ${failed}`); continue; }
    const target = `${process.env.GITLAB_READ_OUT ?? '/tmp/gitlab-read'}/${path}`;
    fs.mkdirSync(target.substring(0, target.lastIndexOf('/')), { recursive: true });
    fs.writeFileSync(target, chunks.join('\n'));
    console.log(`OK   ${path} (${total} lines)`);
  }
} else {
  console.log('usage: glread search <query> [limit] [ref] | read <path> [start_line] [end_line] [ref]');
  process.exit(2);
}
