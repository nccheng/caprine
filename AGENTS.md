# Caprine Agent Contract

## Product and repository scope

- Repository: `nccheng/caprine`; default branch: `main`.
- Caprine AI Assist is a personal, local-first, macOS-only product for Derek.
- Messenger is an untrusted remote renderer. Keep secrets, provider requests,
  private AI output, persistence, and media processing in Caprine-owned local
  surfaces or the Electron main process.
- AI answers remain private until Derek explicitly inserts one into the current
  Messenger draft. Caprine must never press Send.
- Preserve normal Messenger behavior when AI Assist is disabled or a DOM
  adapter fails.
- Use the smallest direct macOS-specific solution. Do not add multi-user,
  multi-provider, plugin, enterprise, or generalized orchestration layers.

The current Linear `Caprine AI Assist` project and its attached product contract
define the MVP behavior and delivery dependencies. An active issue may narrow
that contract but must not silently expand it.

## Authority and bare-link routing

Use authority in this order:

1. Derek's explicit instruction in the current task.
2. This `AGENTS.md`.
3. Team NC's `Convergent Autonomous Implementation and Review Standard`.
4. The active Linear issue or pull request supplied for the task.
5. The `Caprine AI Assist MVP Contract and Delivery Map` and canonical worker
   prompt.
6. Current code, executable checks, and user-facing documentation.

Canonical Linear documents:

- Convergent review standard:
  `https://linear.app/nccheng-personal/document/convergent-autonomous-implementation-and-review-standard-8a7617ca88d6`
- Caprine worker prompt:
  `https://linear.app/nccheng-personal/document/caprine-ai-assist-autonomous-worker-prompt-251f030a0c47`
- Product contract:
  `https://linear.app/nccheng-personal/document/caprine-ai-assist-mvp-contract-and-delivery-map-50fc97314820`

A bare active Linear issue URL from the `Caprine AI Assist` project is a direct
implementation request. Fetch the full issue, project, Review Contract,
attached documents, and `blockedBy` relations; inspect current code and checks;
then begin without requiring a label, ADR, separate approval, or repo-local
issue spec.

Done, Canceled, Duplicate, and other terminal issues are read-only unless Derek
explicitly authorizes an administrative correction. An issue outside this
project is context unless Derek authorizes implementation.

A bare pull-request URL requests inspection and resumption of that PR's existing
lineage. Fetch the PR, linked Linear issue, exact latest head, checks, reviews,
and unresolved threads. Reuse the primary branch/worktree and PR. The PR does
not authorize work outside the linked issue and validated review findings.

## Reviewability gate

Before coding a new issue, verify that it has:

- one independently testable product outcome;
- explicit critical invariants;
- executable acceptance criteria;
- manual-only acceptance separated from code acceptance;
- bounded non-goals;
- identified risk domains and focused deterministic test seams.

Split the issue before implementation when it combines multiple independently
testable high-risk domains such as remote DOM behavior, cross-process
authorization, provider/secrets, persistence, editable UI state, media
processing, and real-device integration.

Do not split mechanically by file or layer. Keep one issue when its parts form
one inseparable user-visible invariant and splitting would create speculative
interfaces or unusable half-features.

If decomposition requires a product decision, stop before coding and report the
proposed Linear split to Derek.

## Dependency-aware work selection

Linear `blockedBy` relations are the work-order gate. Parent/child, milestone,
label, cycle, and issue-number order do not imply blocking.

The daily worker resumes durable active lineage before starting new work:

1. An open primary PR or issue in `In Review`.
2. An issue-matching branch/worktree or issue in `In Progress`.
3. The highest-priority unblocked unfinished project issue.
4. The deepest unfinished in-project blocker required by a blocked issue.

At the same dependency level, order by Linear priority, creation time ascending,
then numeric issue identifier ascending. Detect dependency cycles and stop
rather than guessing. Never autonomously implement an out-of-project blocker.

Start at most one new issue per run. One issue maps to one writer, one
branch/worktree, and one primary PR. Refresh Linear, GitHub, branches, and
worktrees before selection. Preserve unknown or user-owned changes; do not
reset, stash, delete, or force-push them.

Issues labeled `Manual Acceptance` require Derek's participation or supplied
evidence. The autonomous worker skips them rather than fabricating real-device,
credential-dependent, mobile-client, or logged-in Messenger results.

## Convergent implementation and review

### Implementation

For the selected issue:

1. Revalidate that it is active, in-project, reviewable, and unblocked; then set
   it to `In Progress`.
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
2. It directly violates an issue acceptance criterion or critical invariant.
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
   issue Review Contract, critical invariants, previous/revised SHAs, Closure
   Set, proving tests, revision diff, and manual-only checklist.
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
- Per run: resume active lineage first and start at most one new issue.
- Review: one unrestricted Discovery review, one bounded Closure review after
  validated fixes, and at most one targeted repair/verifier escape hatch.
- Success: green required checks and no validated blocker may squash-merge and
  move the issue to `Done`.

Do not create separate selector, writer, reviewer, adjudicator, reconciler, or
merge automations. Do not simulate locks with Linear comments, marker schemas,
prompt hashes, or review digests.

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
