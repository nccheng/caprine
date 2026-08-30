# Caprine Agent Contract

## Product and repository scope

- Repository: `nccheng/caprine`; default branch: `main`.
- Caprine AI Assist is a personal, local-first, macOS-only product for Derek.
- Messenger is an untrusted remote renderer. Keep secrets, provider requests,
  private AI output, persistence, and media processing in Caprine-owned local
  surfaces or the Electron main process.
- Manual AI Assist answers remain private until Derek explicitly inserts one
  into the current Messenger draft; manual mode must never press Send. The
  owner-authorized Quick mode is off by default: an explicit /ai question may
  publish that question and automatically send one native quoted answer under
  the owner's account. Persist each attempted send first, stop on lost authority,
  retain failed/cancelled/uncertain runs, and never automatically retry a send.
- Preserve normal Messenger behavior when AI Assist is disabled or a DOM
  adapter fails.
- Use the smallest direct macOS-specific solution. Do not add multi-user,
  multi-provider, plugin, enterprise, or generalized orchestration layers.

The current Linear `Caprine AI Assist` project and its attached product contract
define MVP behavior and delivery dependencies. An active issue may narrow that
contract but must not silently expand or remove it.

## Authority and bare-link routing

Use authority in this order:

1. Derek's explicit instruction in the current task.
2. This `AGENTS.md`, which is the sole executable implementation, review,
   approval, decomposition, merge, and stop-condition workflow for this
   repository.
3. The active Linear issue or pull request supplied for the task.
4. The `Caprine AI Assist MVP Contract and Delivery Map`.
5. Current code, executable checks, and user-facing documentation.

The Team NC convergent-review document, Caprine worker prompt, project
description, and issue template are supporting references. They must defer to
this file and must not create additional approval or stop gates.

Supporting Linear documents:

- Convergent review reference:
  `https://linear.app/nccheng-personal/document/convergent-autonomous-implementation-and-review-standard-8a7617ca88d6`
- Caprine worker prompt:
  `https://linear.app/nccheng-personal/document/caprine-ai-assist-autonomous-worker-prompt-251f030a0c47`
- Product contract:
  `https://linear.app/nccheng-personal/document/caprine-ai-assist-mvp-contract-and-delivery-map-50fc97314820`

A bare active Linear issue URL from the `Caprine AI Assist` project is a direct
implementation request. Fetch the full issue, project, product contract,
attachments, and `blockedBy` relations; inspect current code and checks; then
begin without requiring a label, ADR, separate approval, repo-local issue spec,
pre-approved Review Contract wording, or pre-approved mechanical decomposition.

Done, Canceled, Duplicate, and other terminal issues are read-only unless Derek
explicitly authorizes an administrative correction. An issue outside this
project is context unless Derek authorizes implementation.

A bare pull-request URL requests inspection and resumption of that PR's existing
lineage. Fetch the PR, linked Linear issue, exact latest head, checks, reviews,
and unresolved threads. Reuse the primary branch/worktree and PR. The PR does
not authorize work outside the linked issue and validated review findings.

## Personal-project autonomy and approval policy

A bare active project issue authorizes implementation and routine issue, PR,
and dependency maintenance within the issue's existing product scope.

Codex is pre-authorized, without separate approval, to:

- derive, shorten, normalize, or repair a Review Contract or bounded review
  packet from the issue goal, scope, acceptance criteria, project contract,
  current code, and tests;
- update the active Linear issue or PR review packet with that derived content;
- separate executable acceptance from manual-only acceptance;
- choose the smallest reversible implementation detail, schema shape, file
  structure, dependency, and deterministic test seam;
- mechanically decompose an issue and rewire Linear dependencies under the
  autonomous decomposition policy below;
- record reasonable implementation assumptions and continue in the same run.

A missing, incomplete, duplicated, or overly verbose Review Contract is not a
stop condition. The reviewability gate evaluates whether the underlying product
outcome and material risk boundaries are clear, not whether prescribed headings
or governance prose already exist.

Do not ask Derek to approve documentation-only or planning-only changes that
preserve existing user-visible behavior, privacy posture, persisted-data
boundaries, destructive scope, dependencies' product meaning, and milestone
outcome. For reversible ambiguity, choose the smallest direct macOS-only
implementation, record the assumption, and proceed.

Return `NEEDS_USER` only when at least one of these conditions is true:

1. Canonical requirements conflict in a way that changes implementation or
   user-visible behavior.
2. Multiple materially different user-visible behaviors remain plausible.
3. Proceeding would newly broaden or reduce sensitive-data retention or
   transmission, permissions, automatic external side effects, destructive
   behavior, project scope, milestone scope, or an MVP commitment.
4. Required owner-provided private evidence, credentials, or real-device action
   is unavailable.
5. The dependency graph is cyclic or materially ambiguous because multiple
   orderings have materially different product consequences.
6. The bounded targeted verifier still fails after its allowed repair.

Missing process prose, incomplete manual-only evidence, naming, internal
architecture preferences, optional refactors, reversible implementation
choices, and mechanically derived dependency changes must not trigger
`NEEDS_USER`.

## Derive-and-continue reviewability gate

Before coding a new issue, evaluate the underlying product work rather than the
presence of a particular template. The issue is reviewable when its existing
sources make these points materially clear:

- one or more independently testable product outcomes whose union is already
  defined by the issue;
- the privacy, security, wrong-conversation, data-loss, auto-send, secret, or
  destructive-operation invariants relevant to the change;
- executable acceptance that can be proven by tests, builds, static checks, or
  unavoidable code-path evidence;
- manual-only acceptance that cannot be proven autonomously;
- bounded non-goals;
- focused deterministic test seams.

When these facts are inferable but missing or verbose in Linear, derive a short
review packet, update the issue or PR when useful, and continue without owner
approval. Ordinary UI, formatting, bounded refactor, and low-risk internal work
may use Goal, Scope, Acceptance Criteria, and Non-goals without a dedicated
Review Contract heading.

Use explicit critical invariants for material boundaries such as secrets,
persistence and migrations, destructive operations, wrong-conversation state,
automatic external side effects, media privacy, and cross-process
authorization. Keep them concise and non-duplicative.

When one issue contains independently testable outcomes or materially distinct
risk boundaries that would make one PR unnecessarily broad, apply the
autonomous decomposition policy. Do not split mechanically by file or layer.
Keep one issue when the parts form one inseparable user-visible invariant and
splitting would create speculative interfaces or unusable half-features.

Do not stop merely because an issue should be decomposed. Stop for decomposition
only when the split itself requires an unresolved product decision under the
`NEEDS_USER` conditions above.

## Autonomous decomposition policy

Issue decomposition is normally an implementation-planning operation, not an
owner approval gate.

Codex is pre-authorized to decompose an active issue and update Linear
relationships without Derek's approval when all of the following are true:

1. Every resulting issue is a strict subset of behavior already required by the
   original issue or project contract.
2. No user-visible behavior, privacy boundary, data-retention policy,
   destructive scope, milestone scope, or MVP commitment is added, removed,
   deferred, or changed.
3. The split only separates independently testable implementation outcomes or
   materially different risk boundaries.
4. Dependencies follow from concrete implementation prerequisites rather than
   a product preference.
5. The original delivery outcome remains completely represented by the union of
   the resulting issues.

Use this reconstruction test:

> If unioning the resulting issues recreates the original issue's required
> behavior without changing product semantics, the decomposition is mechanical.

For a mechanical decomposition, Codex must:

1. Choose the smallest useful split. Prefer two or three coherent slices; avoid
   one issue per UI control, layer, file, or test category.
2. Avoid umbrella, coordination, approval, or governance issues unless they own
   real implementation work.
3. Keep the original issue as a concrete implementation slice when practical;
   do not turn it into a status-only parent unnecessarily.
4. Create or update the minimum Linear issues needed, preserve project,
   milestone, priority, labels, and owner intent, and use `blockedBy` / `blocks`
   as the actual work-order graph.
5. Attach each downstream dependency to the smallest slice or set of slices
   whose completion actually satisfies that prerequisite. Remove obsolete or
   redundant direct edges when safe.
6. Record the decomposition and assumptions in Linear.
7. Immediately continue with the highest-priority unblocked resulting slice in
   the same run. Mechanical decomposition is not completion of the run and is
   not a stop condition.

Do not return `NEEDS_USER` merely because decomposition creates issues or
changes the Linear dependency graph. Those updates are authorized implementation
planning when they follow mechanically from existing requirements.

Return `NEEDS_USER` for decomposition only when at least one material product
decision remains unresolved, including:

- choosing between materially different user-visible behaviors;
- adding, removing, or deferring required MVP scope;
- changing privacy, security, retention, destructive-operation, or automatic
  external-side-effect behavior;
- moving work across milestones in a way that changes delivery semantics;
- selecting between multiple dependency orderings with materially different
  product consequences.

## Dependency-aware work selection

Linear `blockedBy` relations are the work-order gate. Parent/child, milestone,
label, cycle, and issue-number order do not imply blocking.

The daily worker resumes durable active lineage before starting new work:

1. An open primary PR or issue in `In Review`.
2. An issue-matching branch/worktree or issue in `In Progress`.
3. The highest-priority unblocked unfinished project issue.
4. The deepest unfinished in-project blocker required by a blocked issue.

At the same dependency level, order by Linear priority, creation time ascending,
then numeric issue identifier ascending. Detect true dependency cycles and stop
rather than guessing. Never autonomously implement an out-of-project blocker.

Start at most one new implementation issue per run. A mechanical decomposition
may create multiple issue records, but the worker implements at most one
resulting slice. One implementation issue maps to one writer, one
branch/worktree, and one primary PR. Refresh Linear, GitHub, branches, and
worktrees before selection. Preserve unknown or user-owned changes; do not
reset, stash, delete, or force-push them.

Issues labeled `Manual Acceptance` require Derek's participation or supplied
evidence. The autonomous worker skips them rather than fabricating real-device,
credential-dependent, mobile-client, or logged-in Messenger results.

## Convergent implementation and review

### Implementation

For the selected issue:

1. Revalidate that it is active, in-project, and unblocked. Derive or normalize
   its review packet and perform any authorized mechanical decomposition needed
   for reviewability. If decomposed, select the highest-priority unblocked slice
   and continue in the same run. Then set the implementation slice to
   `In Progress`.
2. Implement the smallest complete solution and focused deterministic tests.
3. Run relevant checks, inspect the complete diff, commit, push, and open or
   update the one primary PR.
4. Set the issue to `In Review`.

### Discovery review

Run exactly one fresh clean-context, high-effort adversarial sub-agent against
the exact latest head. It may inspect the complete issue and PR for correctness,
edge cases/tests, privacy/security boundaries, simplicity, and scope.

Discovery findings are candidates, not automatic merge vetoes. The writer or
controller adjudicates every finding as:

- `VALIDATED_BLOCKER`
- `NONBLOCKING_FOLLOWUP`
- `MANUAL_ONLY`
- `OUT_OF_SCOPE`
- `INVALID_OR_UNPROVEN`

A candidate is a `VALIDATED_BLOCKER` only when all material conditions hold:

1. The PR introduces or materially worsens the problem.
2. It directly violates an issue acceptance criterion or material invariant.
3. It has a concrete input/state/execution path and wrong result.
4. It has deterministic evidence, a reproducible operation, or unavoidable
   code-path proof.
5. Its impact is material: privacy/security failure, wrong target, data loss,
   unintended side effect, or user-visible correctness failure.

Naming, style, optional refactors, preferred architecture, speculative
performance concerns, hypothetical future Messenger DOM changes, and
manual-only uncertainty do not block by themselves.

If no validated blocker remains and checks are green, squash-merge and mark the
issue `Done`.

### Closure set and closure review

When validated blockers exist:

1. Freeze a short Closure Set with stable IDs, impact, smallest correction, and
   proving test.
2. Revise only that Closure Set and direct regression coverage. Do not perform
   unrelated cleanup or architecture expansion.
3. Rerun checks, commit, and push.
4. Start one new fresh clean-context Closure reviewer with a bounded packet:
   issue review packet, critical invariants, previous/revised SHAs, Closure Set,
   proving tests, revision diff, and manual-only checklist.
5. The reviewer verifies the frozen findings, critical invariants, and concrete
   revision-caused regressions. It does not begin another unrestricted
   discovery pass.
6. Require the first line to be `PASS`,
   `PASS_WITH_NONBLOCKING_FOLLOWUPS`, or `BLOCKED`.

`PASS` and `PASS_WITH_NONBLOCKING_FOLLOWUPS` are mergeable when required checks
are green.

### Targeted repair escape hatch

If Closure review demonstrates a concrete revision-caused critical defect:

1. Perform one targeted repair limited to that defect.
2. Run one fresh targeted verifier limited to the repaired finding, proving
   tests, and related critical invariants.
3. Do not run another unrestricted review.
4. If targeted verification still fails, stop with `NEEDS_USER`. Do not continue
   an autonomous review/revision loop or start another issue.

Do not use the union of multiple reviewers' findings as the blocker set. A
second unrestricted Discovery reviewer requires Derek's explicit request or an
exceptional critical boundary, and its findings still require adjudication.

## Manual and milestone acceptance

Implementation PRs must truthfully list remaining Messenger, notification,
signing, media, mobile-client, credential-dependent, or end-to-end checks. They
must not claim those checks passed from source inspection, builds, lint, or
packaging.

Real-device checks are centralized in milestone-level Linear issues labeled
`Manual Acceptance`. Free-agent reviewers must not speculate manual uncertainty
into blockers without a concrete current code defect.

A concrete defect found during manual validation becomes a focused Bug issue
that blocks the milestone acceptance issue. Do not hide material code changes
inside a manual validation issue.

## Daily Codex worker

The single scheduled workflow is `Caprine AI Assist Autonomous Worker`:

- Schedule: every day at 11:00 AM `America/Los_Angeles`.
- Default model: GPT 5.6 Sol with High reasoning.
- Runtime: `/Users/nccheng/Documents/GitHub/caprine`.
- Per run: resume active lineage first and start at most one new implementation
  issue. Authorized mechanical decomposition may create issue records and must
  then continue with one eligible slice in the same run.
- Review: one unrestricted Discovery review, one bounded Closure review after
  validated fixes, and at most one targeted repair/verifier escape hatch.
- Success: green required checks and no validated blocker may squash-merge and
  move the issue to `Done`.

The scheduled prompt selects and resumes work, then follows this file. Do not
create separate selector, writer, reviewer, adjudicator, reconciler, or merge
automations. Do not simulate locks with Linear comments, marker schemas, prompt
hashes, or review digests.

## Development commands and conventions

- Required Node.js version: `>=22.12.0`.
- Electron: `^43.4.0`.
- Build: `npm run build`.
- Lint: `npm run lint`.
- Full automated check: `npm test` (build/type checking, focused Node tests, XO,
  and stylelint).
- macOS distribution: `npm run dist:mac`.
- Required issue checks: `npm test` and `git diff --check`, plus focused checks
  required by the issue.
- Compiled main output: `dist-js/`; bundled preloads are built by
  `scripts/build-preloads.mjs`.

Use TypeScript and ES module imports where practical, `const` by default,
2-space indentation, no semicolons, and the existing XO/stylelint configuration.
Keep renderer IPC bound to the owning window/main frame and trusted Messenger
origins, validate payloads before native side effects, and never expose
privileged APIs or secrets to the remote page.
