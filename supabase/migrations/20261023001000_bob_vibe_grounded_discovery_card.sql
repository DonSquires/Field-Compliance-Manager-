INSERT INTO public.bob_knowledge_cards (organization_id, category, key, title, content, tags, source, is_active)
SELECT NULL, 'workflow', 'builder_vibe_grounded_discovery',
       'Vibe: find the real screen before editing and recover without looping',
       $$Before: translate the owner's visible screen labels into verified tracked source candidates. Vibe's VERIFIED STARTING FILES packet reuses Builder's starting-file discovery and Atlas flow map; outlines are bounded source evidence, not proof that the first candidate is the target. A generic session title is not a search term.

During: read the relevant candidate and existing style tokens. A nonexistent guessed filename disproves that guess; search the visible label instead of repeatedly searching for the invented name. CSS is styling, not evidence of a new subsystem. Repeated unchanged read-only calls reuse results; an identical already-successful edit is not replayed without an intervening workspace change. The fourth identical call is blocked; Vibe may recover once using a distinct healthy, installed, allowlisted, memory-eligible local model with the current diff and failed-check output. A second loop stops. Failed writes and failed commands must not reset that guard.

After: verify the actual changed source with relevant tests and report precise receipts. Run web lint for TypeScript edits. Source guard tests importing node:fs/node:path need --environment node; rendering tests need jsdom. Read the test to choose its environment, not to weaken assertions. A failed verification blocks a successful handoff until that same check passes; an unrelated passing command does not clear it. Known failures in bounded continuation receipts remain blockers. If blocked, explain the concrete failure rather than claiming completion. A different model answering, a file edit, and a passing test are separate claims; none proves deployment or live tenant acceptance. Runtime dependency preparation is not a model edit, but actual protected model edits remain refused. Private source, screenshots and session content stay on the private GPU/VPS; the recovery path does not expand to hosted providers.

Atlas flow edges are reads/writes/calls/invokes, not references or FK adjacency. An unavailable Atlas read is explicitly reported, not fabricated. Cross-check writes against the canonical schema before relying on them.$$,
       ARRAY['builder','vibe','discovery','atlas','local-model','tool-recovery','verification'],
       'migration:20261023001000', true
WHERE NOT EXISTS (
  SELECT 1 FROM public.bob_knowledge_cards c
  WHERE c.organization_id IS NULL AND c.key = 'builder_vibe_grounded_discovery'
);
