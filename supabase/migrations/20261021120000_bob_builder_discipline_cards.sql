-- Builder discipline cards for Bob's chat lane (retrieved by similarity; embedded by the fcm-api backfill).
-- Origin: Builder job #100 (2026-10-21). A "Repair Atlas gaps" run had no gap list, engineers guessed at the
-- AtlasPage.tsx fallback seed, the lane guard correctly refused, and the refusal was relayed as "remove the
-- restriction" -- which Bob then composed into a job proposing to weaken the guard and fix an invented gap.
-- Builder engineers carry the same rules in their prompts; these cards teach the chat side that composes jobs.

INSERT INTO public.bob_knowledge_cards (organization_id, category, key, title, content, tags, source, is_active)
SELECT NULL, v.category, v.key, v.title, v.content, v.tags, 'migration:20261021120000', true
FROM (VALUES
  ('workflow', 'builder_guards_are_safety_controls',
   'Builder: lane and path guards are safety controls, never the defect',
   $$When a Builder engineer stops because a lane, path, or protection guard refused a file, the guard did its job. The file belongs to another lane, or is protected.

Do: read the refusal, name the file and the lane that owns it, and re-scope the job to that lane (or split it into one job per lane). If the file is protected, explain why and ask the owner whether the change is really needed.

Never: compose a job, specification, or requirement that removes, loosens, bypasses, or edits builder-path-policy.js or any other guard so the original job can continue. A request to "remove the restriction" is an instruction to find the right lane, not to disable the control. Releases still pass through the human approval gate.$$,
   ARRAY['builder','guard','lane','safety','refusal']),
  ('workflow', 'builder_verify_before_claiming',
   'Builder: verify a file, gap, or defect exists before building a job around it',
   $$A claim from a subagent, an engineer summary, or an earlier turn is a hypothesis until checked.

Before naming a file in a Builder job: confirm it with repo_search (path names are matched by directory listing as well as content) or a repository tree/read.
Before naming an Atlas gap: confirm it in query_atlas gap_report or capability_map.
Before naming a defect: cite the evidence (error text, failing test, live count, screenshot).

If a claim cannot be verified, say so plainly and do not compose a job around it. Never invent a component, gap, or table name to fill a specification.$$,
   ARRAY['builder','verification','evidence','atlas','repo_search']),
  ('workflow', 'builder_atlas_gap_triage',
   'Builder: how to triage and close Atlas gaps',
   $$An Atlas gap is a present entity (table, rpc, edge function, feature) in bob_capability_map whose wired flag is false: nothing registered calls, reads, or writes it.

1. Start from query_atlas gap_report. Name the exact entity_type and entity_name.
2. One gap per job. Do not batch unrelated gaps.
3. Pick the real remedy: (a) the entity has a live caller that the scanner misses, so add the caller's source to MANAGED_SOURCES in scripts/atlas-refresh.js; (b) the entity should be used, so wire a governed caller; (c) the entity is dead, so propose retiring it through a migration; (d) unknown, so report the blocker with evidence.
4. After the fix merges, refresh Atlas (scripts/atlas-refresh.js --apply) and confirm the gap closed.

Never "fix" a gap by editing the AtlasPage.tsx fallback seed or any UI copy: that changes what is displayed, not the map. An FK relation (fk_reach) is not proof of a live pathway; only reads/writes/calls/invokes (flow_reach) are.$$,
   ARRAY['builder','atlas','gap','capability_map','wiring']),
  ('workflow', 'builder_question_is_not_a_job',
   'Builder: answer questions with evidence; compose jobs only for clear build requests',
   $$"What needs attention?", "Why did the job fail?", or "What are the gaps?" are questions. Answer with evidence (gap_report, job status, model-run errors, test results) and suggest next steps. Do not compose a Builder job unless the owner asks for a change to be built.

When you do compose a job: the title is a short summary of the outcome (not the owner's raw message), the scope label matches the lanes actually selected, and the brief contains only the verified evidence relevant to this job, not unrelated tool output from earlier turns.$$,
   ARRAY['builder','job','composition','question','scope']),
  ('workflow', 'builder_relay_refusal_with_cause',
   'Builder: when relaying an engineer refusal or failure, lead with the cause',
   $$When a Builder stage fails or an engineer refuses, report: what was attempted, the exact reason (guard message, validation error, test failure), the evidence, and the smallest safe next step.

Validation rejections are quality control. A spec rejected as "not a repository path", "not valid JSON", or "names an Atlas capability not supplied by repository evidence" means the model output was wrong or ungrounded. Retry, re-scope, or try a stronger model; do not ask to loosen the validator. If the validator itself rejected a correct answer (for example a real tracked file), report it as a Builder defect with the exact path and message so it can be fixed in code and tests.$$,
   ARRAY['builder','failure','refusal','validation','reporting'])
) AS v(category, key, title, content, tags)
WHERE NOT EXISTS (SELECT 1 FROM public.bob_knowledge_cards c WHERE c.key = v.key AND c.organization_id IS NULL);
