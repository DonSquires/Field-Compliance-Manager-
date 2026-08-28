# Bob task continuity contract

## Problem

Bob's current durable state is split across conversation messages, `bob_conversation_facts`, `bob_event_log`, and proposal rows. Conversation facts track entity slots and proposal progress; event logs provide introspection; proposals track governed writes. None of these is a durable ordered checklist for a multi-step read-only task such as recovering a UI architecture from another repository.

As a result, a resumed task can lose the distinction between completed, failed, skipped, and pending steps. A model may repeat a search, submit an empty search, or continue from an incorrect assumption after a timeout or context compaction.

## Required state model

Every multi-step Bob task must have a durable task record with:

- `task_id`
- `conversation_id`
- `organization_id`
- `goal`
- `status`: `active`, `paused`, `completed`, `failed`, or `cancelled`
- `current_step_index`
- `total_steps`
- `updated_at`
- `last_verified_at`
- `last_error`

Each task step must record:

- stable `step_id`
- ordinal position
- requested operation
- normalized tool and arguments
- status: `pending`, `running`, `completed`, `failed`, `blocked`, or `skipped`
- attempt count
- started/completed timestamps
- result summary
- evidence references, such as source paths, line windows, commit SHA, or artifact ID
- error and retryability

## Resume rules

1. Load the task ledger before generating the next tool call.
2. Never repeat a step marked `completed` unless the user explicitly requests revalidation or the evidence is stale.
3. Resume at the first `pending` or retryable `failed` step, not from the natural-language conversation tail.
4. A tool call is not complete because a request was emitted. Mark it completed only after a structured result is received and evidence is attached.
5. Empty, malformed, capped, or `could_not_verify` results do not complete a discovery step.
6. A capped search must create follow-up steps for exact reads; it must not be summarized as a complete audit.
7. When a task pauses, Bob must return a checkpoint containing completed step IDs, next step ID, blocked reason, and evidence references.
8. If the ledger cannot be read or written, Bob must surface `progress_unverified` and stop automated continuation for consequential work. Fail-open observability is not sufficient for task state.

## Repository-audit step contract

Repository discovery should use explicit steps such as:

1. Identify entry points.
2. Identify routing and shells.
3. Identify auth and role gates.
4. Identify data/API dependencies.
5. Trace the target workflow.
6. Read affected files in bounded windows.
7. Produce a verified report.

Each step must carry exact search terms or paths. Broad natural-language instructions must remain in `goal`, never be passed as a search query.

## Evidence requirements

A completed repository step needs at least one of:

- exact file path and read window
- structured tool result with status and count
- source commit SHA/ref
- sanitized report artifact checksum

Bob must distinguish:

- `found`: evidence returned
- `not_found`: clean search with no result
- `could_not_verify`: search failed, auth failed, timeout, or result was otherwise incomplete
- `malformed_query`: tool input was invalid and the step did not run

## Implementation order

1. Add organization-scoped task and task-step persistence using the existing workflow/artifact authorization patterns.
2. Add Conductor helpers to create, claim, complete, fail, pause, and resume steps atomically.
3. Include a compact checkpoint in Bob's next-turn context.
4. Persist repo-search step evidence without storing raw secrets or confidential source content.
5. Add timeout recovery and idempotency keyed by task ID and step ID.
6. Add tests for resume after timeout, duplicate completion, malformed query, capped search, unavailable facts, and context compaction.

Until this ledger exists, Bob's repository audit mode should be treated as advisory and manually checkpointed, not as a reliable autonomous workflow.
