-- Engineering disciplines for Bob Builder, Vibe Builder and in-app Bob are data, not code
-- (owner direction 2026-11-10: "add this to bob builder, viber builder, in-app bob: omniroute,
-- superpowers, claude code setup, claude security").
--
-- Six platform knowledge cards, written for this repository in our own words:
--   * four working methods adapted from the Superpowers skills library
--     (github.com/obra/superpowers, MIT licence, Jesse Vincent) - test-driven development,
--     systematic debugging, brainstorm -> plan -> execute, and verification before completion;
--   * two security-review cards adapted from Anthropic's Claude Code security review action
--     (github.com/anthropics/claude-code-security-review, MIT licence) - the review method and its
--     false-positive filter.
-- Builder chat and Vibe find every card through their knowledge tool. The independent code review
-- also appends active global cards tagged independent_code_review to the reviewer's instructions
-- (builder-independent-code-review.js loadReviewMethodology), so the review method can grow
-- without a code change. Idempotent: a card is inserted only when no active global card owns its key.

INSERT INTO public.bob_knowledge_cards
  (organization_id, category, key, title, content, tags, source, is_active)
SELECT NULL, card.category, card.key, card.title, card.content, card.tags,
  'migration:20261110120000_builder_superpowers_security_review_cards', true
FROM (VALUES
  ('discipline', 'superpowers_test_driven_development',
   'Engineering method: test first, watch it fail, then make it pass',
   $$Adapted from the Superpowers skills library (obra/superpowers, MIT).
Before changing behaviour, write or extend the smallest test that states the expected outcome in this repository's own runner (root contract tests: node --test test/<file>.test.js; web: vitest in apps/web). Run it and see it fail for the expected reason. A test that passes before the change proves nothing about the change.
Then make the smallest production change that turns it green, run it again, and run the neighbouring tests for the same module. Refactor only while green.
Rules: never weaken, skip or delete an assertion to get a pass; never assert on the implementation's private shape when an observable outcome exists; one behaviour per test name, written as the rule it protects (for example "an officer outside the geofence can still close a static stop"). When a bug is reported, the first artefact is a failing test that reproduces it.
For database work, the test reads the migration or exercises the RPC against disposable PostgreSQL where the repository already does so; supabase/schema.sql is regenerated from the live catalogue, never hand-edited.$$,
   ARRAY['builder','vibe','in_app_bob','superpowers','tdd','testing','discipline']),
  ('discipline', 'superpowers_systematic_debugging',
   'Engineering method: find the root cause before fixing anything',
   $$Adapted from the Superpowers skills library (obra/superpowers, MIT).
Do not guess-and-patch. Work in four phases.
1. Investigate: read the full error, the failing receipt and the exact input. Reproduce it with one command. Check what changed recently (git log, migrations, configuration).
2. Compare: find a working example of the same pattern in this repository and list every difference from the broken one. Use Atlas terrain edges and blast radius to see who else reads or writes the same table, RPC or edge function.
3. Hypothesise: state one cause in a sentence and choose the smallest check that could disprove it. Change one variable at a time.
4. Fix at the source: add a failing test for the cause, fix it once where the data originates, and verify the test and the original symptom.
Stop rule: after three failed fixes, stop patching and question the design or the assumption; report evidence, not optimism. Symptoms fixed downstream (UI masking, retries, default values) leave the real defect live.$$,
   ARRAY['builder','vibe','in_app_bob','superpowers','debugging','root_cause','discipline']),
  ('discipline', 'superpowers_brainstorm_plan_execute',
   'Engineering method: understand, plan in small verifiable steps, then execute',
   $$Adapted from the Superpowers skills library (obra/superpowers, MIT).
Brainstorm: before building, restate the owner's goal, the user and job to be done, and what done looks like. Ask the questions whose answers would change the design; otherwise proceed. Prefer the simplest design that fits the canon (FOUNDATION.md, docs/canon) and keeps behaviour data-driven rather than hard-coded.
Plan: write a short plan of small tasks, each with the files it touches, the test that proves it and the command that runs that test. Order tasks so every step leaves the build working. Name the Atlas entities and schema objects each task changes.
Execute: take one task at a time - test, implement, verify, then move on. Keep a running list of what is done, what is verified and what remains. If the plan stops matching reality, stop and revise the plan instead of improvising around it.
Review: before handing back, compare the diff with the plan and the owner's request; remove unrelated changes and anything speculative (YAGNI).$$,
   ARRAY['builder','vibe','in_app_bob','superpowers','planning','discipline']),
  ('discipline', 'superpowers_verification_before_completion',
   'Engineering method: no completion claim without fresh evidence',
   $$Adapted from the Superpowers skills library (obra/superpowers, MIT).
Never say done, fixed, passing or deployed without having just run the command that proves it and read its output. Evidence is specific: the test command and its pass/fail counts, the build exit code, the migration ledger row, the HTTP status, the persisted record or the screenshot of the human path.
Check the claim against the request, not against the plan: does the owner's original symptom now behave correctly before, during and after the action (records, receipts, downstream screens, the next actor)?
If verification could not be run, say exactly what was not verified and why; an unverified change is reported as unverified, never as complete. Pre-existing failures are named separately from failures you introduced, with a baseline comparison.
Words to avoid in place of evidence: should work, probably, looks right, seems fixed.$$,
   ARRAY['builder','vibe','in_app_bob','superpowers','verification','independent_code_review','discipline']),
  ('discipline', 'claude_security_review_method',
   'Security review method: trace untrusted input to a sensitive sink',
   $$Adapted from Anthropic's Claude Code security review (anthropics/claude-code-security-review, MIT).
Review the change, not the whole repository. For every new or modified entry point (route, edge function, RPC, form, import, webhook, file upload), identify who can reach it and what they control, then follow that input to each sensitive sink.
Check these categories: injection (SQL built from strings, command execution, path traversal, template or prompt injection into a model that can act); authentication and authorisation (missing caller checks, SECURITY DEFINER functions without an explicit search_path, REVOKE from PUBLIC/anon or an organisation-scope check, RLS policies that admit another tenant, service-role use reachable from a browser); data exposure (secrets in code or logs, personal, HR, legal, GPS or financial data returned to a role that should not see it, verbose errors); cryptography and tokens (weak randomness, unsigned or unexpiring links, token reuse); unsafe deserialisation, SSRF to internal addresses and open redirects.
For each finding give the file and line, the concrete exploit path (who sends what, and what happens), severity (critical/high/medium/low), confidence out of 10 and the smallest fix. Report only findings with a realistic exploit path and confidence of at least 8.$$,
   ARRAY['builder','vibe','in_app_bob','security','claude_security_review','independent_code_review']),
  ('discipline', 'claude_security_review_false_positive_filter',
   'Security review: exclude false positives before reporting',
   $$Adapted from Anthropic's Claude Code security review (anthropics/claude-code-security-review, MIT).
Before reporting, drop findings that are not real, exploitable vulnerabilities in this change:
- denial of service, resource exhaustion and missing rate limits (report separately as reliability if material);
- secrets or credentials already stored in a managed secret store, and test fixtures with fake keys;
- theoretical race conditions without a concrete interleaving that crosses a trust boundary;
- outdated dependency versions without a reachable vulnerable call;
- memory-safety classes in memory-safe languages;
- issues only in tests, documentation, local scripts or generated files that never run in production;
- missing hardening or best-practice suggestions that do not enable an attack;
- input that is already validated, parameterised or escaped by the framework, the database client or an RLS policy shown in supabase/schema.sql;
- client-side checks where the server or RLS enforces the same rule.
Verify every remaining finding against the actual code path and the live policy text. When unsure, lower the confidence and say what evidence would confirm it rather than inflating severity.$$,
   ARRAY['builder','vibe','in_app_bob','security','claude_security_review','independent_code_review','false_positives'])
) AS card(category, key, title, content, tags)
WHERE NOT EXISTS (
  SELECT 1 FROM public.bob_knowledge_cards existing
  WHERE existing.organization_id IS NULL AND existing.key = card.key AND existing.is_active
);
