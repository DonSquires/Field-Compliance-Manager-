@AGENTS.md

## Claude Code in this repository

- `.claude/hooks/policy.json` holds the guardrails the hooks enforce: protected paths
  (`supabase/schema.sql`, `.github/workflows/`, env files), the release identity and the protected
  `main` branch, plus the fast checks that run after an edit. Change rules there, not in the scripts.
- Before touching shared terrain, run the `atlas-preflight` skill (Atlas capability map, terrain
  edges, blast radius and `supabase/schema.sql`, kept separate).
- `/new-migration` and `/human-test-report` are the repeatable checklists for migrations and
  human-test evidence.
- The `canon-conformance-reviewer` and `ux-states-reviewer` subagents review a diff against the canon
  and against `docs/BOB_ENTERPRISE_SAAS_UX_TRAINING.md`.
- context7 (`.mcp.json`) gives current library documentation; it only receives library names and
  questions, never repository code, records or secrets.
