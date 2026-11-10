---
name: new-migration
description: Checklist for adding a Supabase migration in this repository. Run it explicitly with /new-migration <short_snake_case_name>.
disable-model-invocation: true
---

# New migration: $ARGUMENTS

1. **Preflight.** Run the `atlas-preflight` skill for every table, column, RPC or policy the migration
   touches, and read their current definition in `supabase/schema.sql`. Record what moves.
2. **Version.** Use a UTC timestamp `YYYYMMDDHHMMSS` later than the newest file in
   `supabase/migrations/` and not already used. File: `supabase/migrations/<version>_$ARGUMENTS.sql`.
3. **Write it** so it is safe to re-run where practical (`IF NOT EXISTS`, `CREATE OR REPLACE`, guarded
   inserts). Open with a comment that states the owner direction or issue it serves.
   - New public functions: `SET search_path`, and explicit `REVOKE ... FROM PUBLIC, anon` (and
     `authenticated` when server-only) followed by the intended `GRANT EXECUTE`.
   - New tables: RLS enabled with organisation-scoped policies; helpers used by policies must stay
     executable by the roles the policy targets.
   - Options, labels, rules and modules belong in rows, not in code (data-driven).
   - A line matching `alter table ... drop` makes the VPS release lane skip the migration; say so in
     the PR so it gets a ledgered `supabase db push --linked` after merge.
4. **Test it.** Add or extend a root contract test in `test/` (node:test) that reads the migration and
   asserts the contract; add a disposable-PostgreSQL test behind `BOB_TEST_POSTGRES=1` when behaviour
   needs a real database. Run `node --test test/<file>.test.js`.
5. **Check.** `npm run check:migrations`.
6. **Stop before applying.** Do not apply to the hosted project without the owner's go-ahead. After it
   is applied, print (do not run) the follow-ups:
   - `node scripts/schema-snapshot-live.mjs` to regenerate `supabase/schema.sql`
   - `node scripts/atlas-refresh.js --apply` to refresh Atlas
