-- Chat retrieves these cards; Vibe carries the matching rules in its runtime prompt.
INSERT INTO public.bob_knowledge_cards (organization_id, category, key, title, content, tags, source, is_active)
SELECT NULL, 'workflow', v.key, v.title, v.content, v.tags,
       'migration:20261022223000', true
FROM (VALUES
  ('builder_vibe_continue_from_evidence',
   'Vibe: continue from prior answers, receipts and the current branch',
   $$Before continuing a Vibe build, review the previous owner answers, Bob replies and errors, recent tool/test receipts, branch commits and current diff. Do not ask the same answered question or restart discovery from scratch.

Vibe loads bounded history, not perfect memory: the latest 30 owner/Bob messages and up to 60 recent execution/diff entries. Large results and attachment descriptions are shortened. Verify old edits against current source/diff; a previous successful test is stale if relevant code changed.

Distinguish success from failure: a search returning matches is not a completed repair, a nonzero test exit is a failure, a commit is not deployment, and saved attachment analysis can coexist with a later coding-turn failure. Name the precise failed stage instead of asking the owner to upload the same evidence again.

When a broad search is truncated, narrow its query/path or read a matched file. Repeating identical search arguments yields the same result and can stop the turn. List a directory before guessing a missing filename. Use the recovery hint and existing receipts; do not disable the loop guard or increase the budget to hide a discovery loop.$$,
   ARRAY['builder','vibe','continuation','history','evidence','tool-recovery']),
  ('builder_vibe_profile_navigation_diagnosis',
   'Vibe: trace profile navigation before, during and after the click',
   $$Investigate a profile 404 in five ways: (1) source control and exact generated URL; (2) React route and role gate; (3) HTTP hosting/proxy and base-path behavior; (4) exact Atlas entities plus canonical/live schema and permissions; (5) browser regression tests of the full workflow.

Before: establish the authorised user/role, organisation, selected staff_profiles.id, current route and whether the surface is production or preview. Never use a service-role key to impersonate a user.
During: follow the clicked control, native window.open/link URL, router basename, tab/query parameters, document response and caller-authenticated data reads. The app routes are in apps/web/src/App.tsx, routing/RoleRouter.tsx and shells/AdminShell.tsx, not a guessed routes.tsx.
After: confirm the same staff profile loads, tabs survive refresh, evidence details retain staff/record IDs, and return-to-workspace links remain inside the application. Check unavailable staff produces an explicit permission/data state, without leaking records or weakening RLS.

Vibe preview is served under /vibe/<session-id>/; production uses /. BrowserRouter must use the Vite base and native popout/link hrefs must retain the router base. Do not send preview links to the root of bob.fcmanager.co.nz.

Discover Atlas entity names rather than guessing them: the staff profile component is pages/StaffProfilePage. Empty results do not prove absence. Proven reads/writes/calls/invokes flow_reach is distinct from structural fk_reach; schema and invocation evidence must support stronger claims. A server 404 before app startup is not proof that a staff database row is missing.$$,
   ARRAY['builder','vibe','staff','profile','routing','preview','atlas','before-during-after'])
) AS v(key, title, content, tags)
WHERE NOT EXISTS (
  SELECT 1 FROM public.bob_knowledge_cards c
  WHERE c.organization_id IS NULL AND c.key = v.key
);
