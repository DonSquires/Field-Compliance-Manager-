# Builder compatibility cutover

These three compatibility endpoints use Supabase Builder state and the
GitHub-backed Bob control plane. They do not use research credentials or change
the research function, database policies, or Vercel's `main` deployment lane.

## Job lookup

`bob-read-issues` retains `iid`, `search`, `limit`, `state`, `label`,
`include_comments`, and the `issue`/`issues`/`comments` response wrappers.
An `iid` is now a Builder UUID, branch, workspace branch or full target SHA,
not an external issue number. `search` tries an exact identifier first, then
title search for ordinary text. Both branch columns are checked and results
deduplicated; target SHA is a secondary fallback. Ambiguous families require
a job UUID. No task run is required.

An exact match follows `parent_job_id` to the root and gathers children within
the same organisation and project. The newest descendant in
`implementation_pending`, `building`, `testing` or `approval_pending` is
selected; otherwise the root is returned. `issue.iid` holds that selected UUID;
`state` is its actual Builder status, `labels` contains that status, and
`web_url` is the existing GitHub PR URL or null. Detail also includes
`selected_job_id`, `root_job_id`, and the lineage. Comments are persisted
Builder step summaries, not invented external issue comments.

`state=opened/closed` remains accepted as a list filter; explicit Builder
statuses can also be supplied. `label` filters the actual Builder status.
Missing identifiers return 404, not an empty success. Broken, cyclic,
cross-project or oversized lineages fail explicitly.

## Repository and notes

`bob-repo-search` retains its control-plane `search` and `read` operations,
including redaction, excluded paths and read-progress tracking. `head` and
`tree` use the corresponding control-plane repository routes.

`write_bob_chat` appends a `builder_note` in the existing `bob_self_memory`
table. The legacy `commit_id` is null; `memory_id` is the actual persistence
receipt. `read_bob_chat` reads only these Supabase notes. It does not migrate or
claim to read historical repository notepad content. The legacy path field is
a compatibility label, not a claimed file write. Character windowing remains
available; `has_older_notes` and `next_note_offset` page older batches of 100
notes. No repository commit is created by these aliases.

## Dispatch

`bob-dispatch-flow` retains `flow`, `goal`, `brief`, and
`workflow_id`/`workflow_url`/`workflow_definition`. It resolves the active
GitHub project from `builder_projects` (whose repository columns still carry
historical names), pins current GitHub `main` through the control plane, and
posts the existing camel-case contract to `POST /api/bob/builder/jobs`.
It binds the authenticated requester using the existing audited
`builder_autopilot_bind` RPC and starts the existing `/jobs/:id/run` route.
The existing driver owns workspace creation, commits, gates and GitHub PR
publication. This endpoint neither merges nor deploys.

Optional `project_id`, `organization_id`, `task_run_id`, `job_id`,
`conversation_id`, `target_sha`, `requested_action`, `target_environment`,
`code_review_mode`, `frontend_required` and `backend_required` are accepted.
`job_id` resumes an existing nonterminal job without requiring a task run.
Without one, exact same-brief active retries reuse an existing dispatch job.
Concurrent create requests without a task run are not an exactly-once API;
use the durable returned job ID for retries. If runner acceptance fails after
creation, the error retains `workflow_id` so the caller can resume that job.
`workflow_url` stays null until a real publication URL exists; a dispatch
receipt does not claim a PR, preview, merge or deployment.

## Validation and release

From the repository root:

```sh
node --test supabase/functions/bob-read-issues/cutover.test.mjs
deno check --no-config supabase/functions/bob-read-issues/jobs.ts \
  supabase/functions/bob-dispatch-flow/dispatch.ts
```

The HTTP tests run the actual three Deno handlers against synthetic local
Supabase/control-plane services, with runtime networking restricted to
localhost. They require Deno and a free port 8000. No production secrets,
business writes or provider calls are used.

Preserve the deployed platform settings: lookup has JWT verification enabled;
repository and dispatch have it disabled and retain their internal JWT and
admiral authorization checks. Deploy only these three functions, and only
after the PR has been reviewed and merged. No database migration is required.
