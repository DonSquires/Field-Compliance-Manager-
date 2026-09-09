# Bob's Atlas + Schema Directive

Every Dr. Bob human-test finding must follow this order before proposing a fix.

## 1. Capture the observed symptom

Record the exact visible error, URL, action, browser, and timestamp. Preserve the browser/network status rather than paraphrasing it.

## 2. Check Atlas capability state

Query `bob_capability_map` for the page, RPC, table, and relevant column. Report all three states:

- `present`: the entity exists in the tracked terrain.
- `wired`: a real caller or edge is registered.
- `exercised`: the path has actually run.

Then query `bob_app_map_edges` for direct `reads`, `writes`, `calls`, `invokes`, and `secured_by` edges. Treat `references` and `fk_references` as weaker structural evidence, not proof of a live path.

## 3. Cross-check schema truth

Read `supabase/schema.sql` and the owning migration. Compare:

- Function name and exact argument names/types.
- Table and column definitions.
- Trigger bodies and policies.
- Grants and migration ordering.

A migration defining an entity while `schema.sql` does not contain it is **schema/migration drift**. It is not enough evidence to say the live database is missing the entity. Verify the target project's `pg_proc` and migration ledger before changing UI code.

## 4. Classify the contradiction

Bob must choose one of these states:

- **Caller contract mismatch:** frontend sends the wrong named parameters or action values.
- **Migration/schema drift:** repository snapshot and migration history disagree.
- **Deployment drift:** local code is correct but the deployed asset or database is old.
- **Unwired:** Atlas has the entity but no real caller edge.
- **Unexercised:** wiring exists but no proven runtime exercise exists.
- **RLS/policy failure:** the function/table exists but the user cannot perform the operation.
- **Unknown:** evidence conflicts; do not invent a root cause.

## 5. Name one next move

The next move must be a cheap discriminating check, not a broad rebuild. Examples:

- Query live `pg_proc` for the exact function identity arguments.
- Check `supabase_migrations.schema_migrations` for the migration version.
- Compare the deployed frontend asset commit with the source commit.
- Run the same human action once in a controlled environment.
- Refresh Atlas only after the path has genuinely been exercised.

Never hand-edit Atlas edges to make a feature appear wired. Keep flow reach and FK reach separate.

## Automated directive test

```bash
cd apps/web
SUPABASE_URL="$SUPABASE_URL" \
SUPABASE_SERVICE_ROLE_KEY="$SUPABASE_SERVICE_ROLE_KEY" \
npx playwright test e2e/bob-atlas-schema-directive.spec.ts
```

The test prints the evidence matrix and Bob's selected next move. It currently uses the dispatch operator RPC as the concrete example because the human walkthrough exposed a PostgREST signature error there.
