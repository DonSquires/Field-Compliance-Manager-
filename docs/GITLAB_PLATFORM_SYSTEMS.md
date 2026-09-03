# GitLab Platform Systems Spec

Date: 2026-09-03

Source: live Bob `bob-repo-search` reads against GitLab project `83317421`, ref `Main`, using a grandmaster test session. This repository is intended to be the GitLab build's copy/mirror line with additional rebuild work layered here. These systems are therefore required in this build repo, not optional references.

## System Boundary

Atlas, Caddie, Conductor, and Oracle are four different platform systems. They must not be collapsed into one generic "Bob" feature.

| System | Owns | Does not own | Primary GitLab anchors |
| --- | --- | --- | --- |
| Atlas | Generated self-model of what exists, what is connected, what is wired, what is exercised, and what changes can reach. | Business intent or judgment. | `bob_capability_map`, `bob_app_map_edges`, `bob-query-atlas`, `atlas-scan.mjs`, `refresh-capability-map.mjs` |
| Caddie | Bob's tool catalogue provenance: the menu comes from Atlas terrain instead of a stale hardcoded list. | Tool choice, planner judgment, or effect permission. | `docs/design/CADDIE_BRIEF.md`, `supabase/functions/onspace-ai-chat/caddie.ts` |
| Conductor | Turn gate, dispatcher, and egress/consequence enforcement at the post-selection, pre-effect seam. | Truth-state description or Bob's internal reasoning. | `supabase/functions/onspace-ai-chat/index.ts`, `docs/enforcement-architecture.md` |
| Oracle | Truth-state description for the current turn, caller, candidate effect, proof grade, and domain state. | Enforcement, blocking, permitting, or choosing. | `docs/enforcement-architecture.md`, `conductor-welfare-seam.ts`, `packages/shared/src/welfareSafetySignal.ts` |

## Governing Doctrine

The GitLab enforcement architecture says governance applies to what leaves the build, not to what Bob reads, thinks, considers, or internally selects.

Bob's internal plane is broad across the organism: Atlas, live schema, knowledge corpus, cross-tenant operational context over the ratified data floor, conversation history, resolved facts, task state, Oracle truth-state, and other reasoning inputs. Tenant isolation and consequence control are egress properties, not internal blindness.

Effects are classified before leaving the build:

- `internal_observation`: Bob reading, reasoning, cross-referencing, or transient turn state. Never egress.
- `disclosure_egress`: answer, cockpit render, report, or notification text surfaced to a human.
- `safety_signal`: alert, escalation, or welfare notification directed at preventing immediate harm.
- `draft_governed_write`: proposal, draft record, or staged mutation awaiting human confirmation.
- `direct_world_change`: durable write, dispatched action, record mutation, or external notification.
- `admin_diagnostic_substrate_action`: CI job, deploy, schema migration, or infrastructure-level effect.

Conductor enforces at the post-selection, pre-effect seam. Bob selects internally; Oracle describes truth-state; Conductor permits, downgrades, or blocks the candidate effect.

## Atlas Spec

Atlas maps terrain. It is the build's generated self-model.

`bob_capability_map` is the node map. It classifies `table`, `column`, `rpc`, `edge_function`, and `feature` entities using:

- `present`
- `wired`
- `exercised`
- `caller_summary`
- `notes`
- `refresh_source`
- `retirement_status`

Its purpose is to stop Bob and builders from assuming schema presence means working product behavior.

`bob_app_map_edges` is the edge graph. It records directed references between `table`, `column`, `rpc`, `edge_function`, `feature`, `route`, and `component` entities. Edge kinds include:

- `reads`
- `writes`
- `calls`
- `invokes`
- `imports`
- `references`
- `fk_references`

Every edge records `evidence_class`, `retirement_status`, `source_file`, `migration_name`, `caller_context`, and `refresh_source`.

Atlas generation is read-only static analysis. GitLab anchors show `refresh-capability-map.mjs` and `atlas-scan.mjs` scan migrations, functions, web/API source, RPC calls, Supabase `.from()` usage, FK constraints, triggers, policies, edge functions, and HTTP hops. Terrain is generated; intent is authored separately in `app_map_expectations`.

Blast radius is a first-class Atlas API through `bob-query-atlas`:

- `capability_map`: list present/wired/exercised entities.
- `terrain_edges`: list live one-hop edges.
- `gap_report`: list unwired or unexercised non-retired capabilities.
- `blast_radius`: walk impact from a node.

The blast-radius rule is hard: `flow_reach` and `fk_reach` are different truths.

- `flow_reach` is proven directed data flow through `writes`, `reads`, `calls`, and `invokes`.
- `fk_reach` is structural relation only through `fk_references` and `references`; it is undirected and never proof that data flows.

Both reach functions are cycle-guarded, depth-capped, and live-edge-only. Any build or review that touches shared terrain should ask Atlas what the change reaches before acting.

## Caddie Spec

Caddie gives Bob the whole tool menu before Bob chooses any part of it. The governing principle from the GitLab brief is: "You must know the whole before you work on the part."

Caddie replaces hardcoded catalogue provenance with Atlas-generated catalogue provenance. It does not redesign Bob's planner and does not choose tools.

The constitutional split:

- Atlas maps reach.
- Bob selects by judgment.
- Caddie generates the menu.
- Conductor governs effects.

The original Caddie brief says generated tools must still pass the rank/access envelope. Later GitLab enforcement architecture and `caddie.ts` refine this: Caddie maps Bob's full capability awareness and classifies each tool by `effect_class`; Conductor enforces rank and effect permission at the post-selection, pre-effect seam. This repo should preserve the later enforcement split while keeping the Caddie brief's drift-fail discipline.

Caddie acceptance rules:

- Catalogue entries come from live Atlas terrain, not hand-maintained guesses.
- A tool with no terrain node is a lie.
- A wired terrain tool absent from the catalogue is invisible to Bob.
- Surface labels must not collide; collisions fail deterministically.
- Shared Bob route contracts must be reconciled with the live Conductor so names do not drift.
- Caddie must not widen Atlas, complete the gap engine, redesign the planner, bypass governance, or self-merge.

## Conductor Spec

Conductor is Bob's turn gate and dispatcher. The GitLab `onspace-ai-chat` source describes it as a thin gate plus dispatcher, not the thing that chooses by keyword.

Conductor responsibilities:

- Load user/caller capability context and tier.
- Load memory, facts, task state, knowledge, and constitutional lane content.
- Receive Bob's selected intent/tool from the planner.
- Classify the selected tool/effect using Caddie `effect_class` metadata.
- Enforce rank/effect permission before the effect leaves the build.
- Dispatch allowed tools to edge functions or internal handlers.
- Preserve blocked selected intent in audit/conversation metadata.
- Keep operational writes behind proposal, approval, or governed write paths.

Important GitLab rules:

- Conductor does not gate Bob's reading, reasoning, or internal selection.
- Direct write tools must never execute from ordinary chat path unless specifically governed.
- Proposal tools may create draft/pending actions that require human approval.
- Enforcement runs both before the first tool effect and inside the reasoning/tool loop, so later selected tools are not allowed to escape the same gate.

## Oracle Spec

Oracle is broader than the safety system. Welfare is one domain-specific Oracle application, not the whole Oracle.

The enforcement architecture defines Oracle as the truth-state describer. It answers what is true right now about this turn, caller, and candidate effect. It does not block, permit, or choose.

Core Oracle truth-state fields from GitLab doctrine:

- `explicit_hold`: whether the current turn carries a hold instruction.
- `effect_class`: the candidate effect class.
- `turn_scope`: caller rank, scoped organization IDs, and capability envelope.
- `proof_grade`: epistemic grade of the candidate effect, such as observed, inferred, alleged, or determined.

Oracle may also include domain truth-state required by the effect. The welfare safety module is the current concrete example:

- `welfare_status`: `ok`, `due`, `overdue`, `man_down`, or `sos`.
- `welfare_escalation_level`: `L1`, `L2`, or `L3` when active.
- `last_welfare_signal`: timestamp and signal type.
- `active_sos`, `active_man_down`, `active_overdue`.

Safety signal actions ratified in the GitLab Oracle/Conductor welfare spec:

- `alert_raise`
- `last_known_context_pin`
- `dispatcher_notify`
- `escalation_timing`

Safety signalling may proceed under explicit hold only when it is non-record-mutating, bounded, auditable, and directed to preventing immediate harm. SOS is not a bypass for governed writes: safety signalling may pass, but operational/governed writes remain blocked or require human gate.

Implementation rule: whenever this repo builds an Oracle for another domain, keep the same separation. Oracle describes truth-state; Conductor enforces consequences.

## Local Build Requirements

1. Treat GitLab as the target copy/mirror source for these platform systems, with extra work in this repo layered coherently.
2. Before editing shared terrain, use Atlas capability map, terrain edges, and blast radius.
3. Keep Caddie as catalogue provenance, not planner judgment.
4. Keep Conductor as the post-selection, pre-effect enforcement boundary.
5. Use Oracle for general truth-state, not just welfare. Add domain truth-state through pure describers where possible.
6. Preserve effect-class enforcement. Do not hide tools to make governance feel easier; enforce at egress/consequence.
7. Do not port old Freedom Camping architecture wholesale. Fill missing capabilities through the current SaaS spine.