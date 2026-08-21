import { createClient } from "npm:@supabase/supabase-js@2.49.8";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
if (!SUPABASE_URL) throw new Error("SUPABASE_URL is required");
Deno.serve(async (req)=>{
  if (req.method !== "POST") {
    return new Response("Method not allowed", {
      status: 405
    });
  }
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return new Response("Missing Authorization header", {
      status: 401
    });
  }
  const apiKey = req.headers.get("apikey");
  if (!apiKey) {
    return new Response("Missing apikey header", {
      status: 401
    });
  }
  const body = await req.json();
  const jobId = body?.job_id;
  const stage = body?.stage;
  const decision = body?.decision;
  const comment = body?.comment ?? null;
  if (!jobId || !stage || !decision) {
    return new Response("job_id, stage, and decision are required", {
      status: 400
    });
  }
  const supabase = createClient(SUPABASE_URL, apiKey, {
    global: {
      headers: {
        Authorization: authHeader
      }
    }
  });
  const { data, error } = await supabase.rpc("wf_approve_job", {
    _job_id: jobId,
    _stage: stage,
    _decision: decision,
    _comment: comment
  });
  if (error) {
    return new Response(JSON.stringify({
      error: error.message
    }), {
      status: 400,
      headers: {
        "Content-Type": "application/json"
      }
    });
  }
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: {
      "Content-Type": "application/json"
    }
  });
});
