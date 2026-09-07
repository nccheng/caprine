# Caprine AI Assist autonomous worker

/goal Advance the Plane project `Caprine AI Assist` by at most one issue in this run, using the convergent implementation and review protocol.

Repository:
`nccheng/caprine`

Default branch:
`main`

Local repository:
`/Users/nccheng/Documents/GitHub/caprine`

Canonical authorities:

1. Derek's explicit instruction in the current task.
2. Root `AGENTS.md`.
3. Team NC document `Convergent Autonomous Implementation and Review Standard`.
4. The active Plane issue and its Review Contract.
5. The `Caprine AI Assist MVP Contract and Delivery Map`.

## Start of run

1. Fetch the latest GitHub, Plane, branch, PR, and worktree state.
2. Read root `AGENTS.md` and both canonical Plane documents.
3. Resume durable active lineage before selecting new work:
   * open primary PR or issue in In Review;
   * issue-matching branch/worktree or issue in In Progress;
   * highest-priority unblocked Todo issue;
   * deepest unfinished in-project blocker required by a blocked issue.
4. Use Plane `blocked_by` relations as the work-order gate. At the same dependency level, use priority, creation time ascending, then numeric issue ID ascending.
5. Start at most one new issue.
6. Never duplicate a branch, worktree, PR, issue lineage, or implementation attempt.
7. Skip issues labeled `Manual Acceptance` unless Derek explicitly starts the validation or supplies the required evidence.
8. Skip issues blocked on an unavailable owner-provided private source. Do not fabricate private data or manual evidence.

## Reviewability gate

Before implementation, verify that the issue has one independently testable outcome, explicit critical invariants, executable acceptance, manual-only acceptance, bounded non-goals, risk domains, and expected test seams.

If the issue combines multiple independently testable high-risk domains, stop before coding and report a proposed Plane decomposition. Do not create speculative interfaces or split a single inseparable invariant mechanically.

## Implementation

1. Revalidate that the issue is active, in-project, and unblocked.
2. Set it to In Progress.
3. Implement the smallest complete solution and focused deterministic tests.
4. Run relevant checks, inspect the complete diff, commit, push, and open or update the one primary PR.
5. Set the issue to In Review.

## Discovery review

Run exactly one fresh clean-context, high-effort adversarial sub-agent against the exact latest head.

The reviewer may inspect the complete issue and PR, but its findings are candidates rather than automatic merge vetoes.

The writer/controller must adjudicate each finding as:

* `VALIDATED_BLOCKER`
* `NONBLOCKING_FOLLOWUP`
* `MANUAL_ONLY`
* `OUT_OF_SCOPE`
* `INVALID_OR_UNPROVEN`

A validated blocker must be owned by the PR, violate an acceptance criterion or critical invariant, have a concrete execution path, have deterministic evidence or unavoidable code-path proof, and have material impact.

If no validated blocker remains and checks are green, squash-merge and mark the issue Done.

## Closure revision and review

If validated blockers exist:

1. Freeze a short Closure Set with stable IDs, impact, smallest correction, and proving test.
2. Revise only the Closure Set and direct regression coverage. Do not perform unrelated cleanup or architecture expansion.
3. Rerun checks, commit, and push.
4. Start one new fresh clean-context Closure reviewer with a bounded Closure Packet:
   * issue Review Contract;
   * critical invariants;
   * previous and revised SHAs;
   * frozen Closure Set;
   * regression tests;
   * revision diff;
   * manual-only checklist.
5. The Closure reviewer verifies the frozen findings, critical invariants, and revision-caused regressions. It does not begin another unrestricted discovery pass.
6. Require the first line to be `PASS`, `PASS_WITH_NONBLOCKING_FOLLOWUPS`, or `BLOCKED`.
7. `PASS` and `PASS_WITH_NONBLOCKING_FOLLOWUPS` are mergeable when checks are green.

## Targeted repair escape hatch

If Closure review identifies a concrete revision-caused critical defect:

1. Perform one targeted repair limited to that defect.
2. Run one fresh targeted verifier limited to the repaired finding, proving tests, and related critical invariants.
3. Do not run another unrestricted review.
4. If targeted verification still fails, stop with `NEEDS_USER` and do not begin another issue.

## Manual acceptance

Implementation PRs may list remaining real-Messenger/macOS checks, but free-agent reviewers must not speculate manual uncertainty into blockers without a concrete current code defect.

Milestone-level issues labeled `Manual Acceptance` own real-device, credential-dependent, mobile-client, and logged-in Messenger evidence. Concrete defects found there become focused Bug issues that block the acceptance issue.

## Completion

When the latest bounded review is mergeable and required checks pass:

1. Squash-merge the primary PR.
2. Mark the Plane issue Done.
3. Record the merge SHA, checks, review classification, non-blocking follow-ups, and remaining milestone-level manual evidence.
4. Stop after the one selected issue.

Do not create separate selector, writer, reviewer, adjudicator, reconciler, or merger automations. Do not use review hashes, marker schemas, simulated locks, or reviewer-finding union as a merge gate.

## Plane migration compatibility

Workspace `team-nc` (`f223b880-1f10-40f1-b22c-9070248fd0e1`), project `Caprine AI Assist` / `CAP` (`e939c63a-ad50-4756-80b9-8c83aec0d950`). Root `AGENTS.md` remains the sole executable workflow; `PLANE_MIGRATION.md` provides historical aliases and source constraints. Resolve actual tool schemas, state UUIDs and full pagination. Exclude archived/synthetic items and terminal work. Native `blocked_by` / `blocking` is the work-order graph; module order and parent-child relations are not blockers. Unknown dependencies and failed lookups are not evidence of completion. Only verified Done prerequisites may be treated as completed.

Order equal-level eligible work by urgent, high, medium, low, none; original createdAt then numeric BUI alias for migrated work, otherwise Plane created_at then numeric CAP identifier. Resume existing PR/branch/worktree lineage before new selection. Resolve old BUI links through the map rather than starting duplicate work. Historical Linear project `e4c3c746-951b-41bb-b918-be89645f15f9` is read-only after cutover.

CAP-1 / BUI-212, CAP-2 / BUI-233 and CAP-3 / BUI-234 are all Manual Acceptance; preserve every source requirement and skip autonomous implementation absent owner participation or supplied evidence. CAP-1 is natively blocked by CAP-2 and CAP-3. Tests, fixtures, source inspection and packaging do not prove real Messenger, Mac, mobile-client or credential-dependent acceptance.

Explicitly link the GitHub PR on Plane and the Plane item in the PR. Do not assume Closes CAP-### updates Plane automatically. Verify merge reachability on remote main before explicitly marking Plane Done; reconcile only stale metadata when already merged. QA-only schedules retain their narrower original write scope and never implement, merge or change issue status. Deduplicate fresh QA evidence against mapped active work and historical Linear evidence; any newly confirmed recurrence is tracked in Plane, never by reopening historical Linear.


## Existing schedule

The actual app automation remains scheduling authority: hourly at minute 0, gpt-5.6-sol with high reasoning, canonical Caprine checkout, originally PAUSED. Migration preserves all settings and does not enable this worker. Root AGENTS.md controls its review and delivery workflow.
