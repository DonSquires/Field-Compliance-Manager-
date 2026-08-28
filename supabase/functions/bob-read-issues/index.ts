import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { OWNER_EMAILS } from '../_shared/auth.ts';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const GITLAB_TOKEN = Deno.env.get('GITLAB_TOKEN') ?? '';
const GITLAB_PROJECT_ID = Deno.env.get('GITLAB_PROJECT_ID') ?? '83317421';
const GITLAB_BASE_URL = (Deno.env.get('GITLAB_BASE_URL') ?? 'https://gitlab.com').replace(/\/+$/, '');
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};
const json = (b, s = 200)=>new Response(JSON.stringify(b), {
    status: s,
    headers: {
      ...CORS,
      'Content-Type': 'application/json'
    }
  });
const gl = (path)=>fetch(`${GITLAB_BASE_URL}/api/v4/projects/${encodeURIComponent(GITLAB_PROJECT_ID)}${path}`, {
    headers: {
      'PRIVATE-TOKEN': GITLAB_TOKEN
    }
  });
serve(async (req)=>{
  if (req.method === 'OPTIONS') return new Response('ok', {
    headers: CORS
  });
  if (req.method !== 'POST') return json({
    error: 'POST required'
  }, 405);
  try {
    const authHeader = req.headers.get('Authorization') ?? '';
    if (!authHeader) return json({
      error: 'Unauthorized'
    }, 401);
    const caller = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: {
        headers: {
          Authorization: authHeader
        }
      }
    });
    const { data: { user }, error: authErr } = await caller.auth.getUser();
    if (authErr || !user) return json({
      error: 'Unauthorized'
    }, 401);
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: profile } = await admin.from('user_profiles').select('role').eq('id', user.id).single();
    const isOwner = OWNER_EMAILS.has((user.email ?? '').toLowerCase().trim());
    if (!isOwner && String(profile?.role ?? '') !== 'grand_master') return json({
      error: 'Forbidden: admiral only'
    }, 403);
    if (!GITLAB_TOKEN) return json({
      error: 'GITLAB_TOKEN not configured'
    }, 503);
    const body = await req.json();
    const limit = Math.min(Math.max(Number(body.limit ?? 20), 1), 50);
    if (body.iid !== undefined && body.iid !== null) {
      const iid = parseInt(String(body.iid), 10);
      if (!Number.isFinite(iid)) return json({
        error: 'iid must be a number'
      }, 400);
      const issueRes = await gl(`/issues/${iid}`);
      if (!issueRes.ok) return json({
        ok: false,
        error: `GitLab returned ${issueRes.status}`
      }, 502);
      const issue = await issueRes.json();
      let comments = [];
      if (body.include_comments !== false) {
        try {
          const notesRes = await gl(`/issues/${iid}/notes?sort=asc&per_page=50`);
          if (notesRes.ok) {
            const raw = await notesRes.json();
            comments = raw.map((n)=>({
                author: n.author?.username ?? 'unknown',
                body: String(n.body ?? '').slice(0, 1000),
                created_at: n.created_at,
                system: n.system ?? false
              }));
          }
        } catch (_e) {}
      }
      return json({
        ok: true,
        issue: {
          iid: issue.iid,
          title: issue.title,
          state: issue.state,
          description: String(issue.description ?? '').slice(0, 8000),
          labels: issue.labels,
          author: issue.author?.username,
          web_url: issue.web_url
        },
        comments
      });
    }
    const params = new URLSearchParams({
      per_page: String(limit),
      order_by: 'updated_at',
      sort: 'desc'
    });
    if (body.state) params.set('state', body.state);
    if (body.label) params.set('labels', body.label);
    if (body.search) params.set('search', body.search);
    const listRes = await gl(`/issues?${params.toString()}`);
    if (!listRes.ok) return json({
      ok: false,
      error: `GitLab returned ${listRes.status}`
    }, 502);
    const issues = await listRes.json();
    return json({
      ok: true,
      count: issues.length,
      issues: issues.map((i)=>({
          iid: i.iid,
          title: i.title,
          state: i.state,
          labels: i.labels,
          web_url: i.web_url
        }))
    });
  } catch (err) {
    console.error('[bob-read-issues]', err);
    return json({
      error: 'Internal error'
    }, 500);
  }
});
