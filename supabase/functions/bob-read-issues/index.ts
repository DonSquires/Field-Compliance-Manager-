import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { OWNER_EMAILS } from '../_shared/auth.ts';
import { findJobs, issueView, jobLineage, JOB_COLUMNS, UUID } from './jobs.ts';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};
const json = (b: unknown, s = 200)=>new Response(JSON.stringify(b), {
    status: s,
    headers: {
      ...CORS,
      'Content-Type': 'application/json'
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
    const body = await req.json();
    const rawLimit = Number(body.limit ?? 20);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.floor(rawLimit), 1), 50) : 20;
    const search = String(body.search ?? '').trim();
    const explicit = body.iid !== undefined && body.iid !== null;
    const identifier = explicit ? String(body.iid).trim() : search;
    if (explicit && !identifier) return json({ error: 'iid must identify a Builder job' }, 400);
    if (identifier) {
      const matches = await findJobs(admin, identifier);
      if (matches.length) {
        const families = new Map<string, Awaited<ReturnType<typeof jobLineage>>>();
        for (const match of matches) {
          if ([...families.values()].some(family => family.lineage.some(job => job.id === match.id))) continue;
          const family = await jobLineage(admin, match);
          families.set(family.root.id, family);
          if (families.size > 1) return json({ ok: false, error: 'More than one Builder job lineage matches. Use the job UUID.' }, 400);
        }
        if (families.size !== 1) return json({ ok: false, error: 'More than one Builder job lineage matches. Use the job UUID.' }, 400);
        const { root, selected, lineage } = [...families.values()][0];
        let comments: Array<{ author: string; body: string; created_at: string | null; system: boolean }> = [];
        if (body.include_comments !== false) {
          const { data, error } = await admin.from('builder_job_steps')
            .select('step_id,result_summary,completed_at,started_at').eq('job_id', selected.id)
            .order('ordinal_position', { ascending: true }).limit(50);
          if (error) throw error;
          comments = data.filter(step => step.result_summary).map(step => ({
            author: `Builder / ${step.step_id}`, body: String(step.result_summary).slice(0, 1000),
            created_at: step.completed_at ?? step.started_at, system: false,
          }));
        }
        return json({ ok: true, issue: issueView(selected, true), comments,
          root_job_id: root.id, selected_job_id: selected.id, lineage });
      }
      if (explicit || UUID.test(identifier) || identifier.startsWith('bob/job-') || /^[a-f0-9]{7,40}$/i.test(identifier)) {
        return json({ ok: false, error: 'Bob job was not found in Builder job records.' }, 404);
      }
    }
    let request = admin.from('builder_jobs').select(JOB_COLUMNS).order('updated_at', { ascending: false }).limit(limit);
    if (body.state === 'opened') request = request.not('status', 'in', '(deployed,failed,cancelled)');
    else if (body.state === 'closed') request = request.in('status', ['deployed', 'failed', 'cancelled']);
    else if (body.state) request = request.eq('status', String(body.state));
    if (body.label) request = request.eq('status', String(body.label));
    if (search) request = request.ilike('title', `%${search.replace(/[%_\\]/g, '\\$&')}%`);
    const { data: issues, error } = await request;
    if (error) throw error;
    return json({
      ok: true,
      count: issues.length,
      issues: issues.map(job => issueView(job))
    });
  } catch (err) {
    console.error('[bob-read-issues]', err);
    return json({
      error: 'Internal error'
    }, 500);
  }
});
