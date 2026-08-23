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
define the complete MVP behavior and delivery dependencies. An active issue may
narrow that contract but must not silently expand it.

## Authority and bare-link routing

Use authority in this order:

1. Derek's explicit instruction in the current task.
2. The active Linear issue or pull request supplied for the task.
3. The current `Caprine AI Assist` Linear project and attached product contract.
4. Current code, executable checks, and user-facing documentation.

A bare active Linear issue URL from the `Caprine AI Assist` project is a direct
implementation request. Fetch the full issue, project, attached product
contract, and `blockedBy` relations; inspect the current code and checks; then
begin the issue without requiring a label, embedded prompt, ADR, separate
approval, delivery classification, or repo-local issue spec.

Done, Canceled, Duplicate, and other terminal issues are read-only. If an issue
is outside `Caprine AI Assist`, treat its URL as context unless Derek explicitly
authorizes implementation.

A bare pull-request URL is a request to inspect and resume that PR's existing
lineage. Fetch the PR, linked Linear issue, project contract, latest head,
checks, reviews, and unresolved threads before acting. Reuse the primary PR and
its branch/worktree rather than creating parallel lineage. The PR does not
authorize work beyond its linked issue and review findings.

## Dependency-aware work selection

Linear `blockedBy` relations are the only work-order gate. Parent/child,
milestone, label, cycle, or issue-number order does not imply blocking.

The daily worker resumes durable active lineage before starting new work:

1. An open primary PR or issue in `In Review`.
2. An issue-matching branch/worktree or issue in `In Progress`.
3. The highest-priority unblocked unfinished project issue.
4. When no unblocked target is available, the deepest unfinished blocker
   required by a blocked project issue.

At the same dependency level, order by Linear priority, creation time ascending,
then numeric issue identifier ascending. Detect dependency cycles and stop rather
than guessing through one. Never autonomously implement an out-of-project
blocker.

Start at most one new issue per run. One issue maps to one writer, one
branch/worktree, and one primary PR. Refresh Linear, GitHub, branches, and
worktrees before selection, and resume existing lineage rather than duplicating
it. Preserve unknown or user-owned changes; do not reset, stash, delete, or
force-push them.

## Implementation, review, and completion

For the one selected issue:

1. Revalidate that the issue is active, in-project, and unblocked, then set it
   to `In Progress`.
2. Implement the smallest complete solution and focused deterministic tests
   where executable behavior changes.
3. Run relevant checks, inspect the complete diff, commit, push, and open or
   update the one primary PR.
4. Set the issue to `In Review`.
5. Start one fresh clean-context adversarial sub-agent against the exact latest
   head. It reviews correctness, edge cases and tests, privacy and security
   boundaries, simplicity, and issue scope.
6. If that review finds concrete blockers, the original writer revises the
   implementation and reruns checks.
7. Start a new clean-context adversarial sub-agent against the revised latest
   head for the second and final review round.
8. If blockers remain after round two, stop and report them to Derek. Do not
   start another issue.
9. If the latest-head review is clean and required checks pass, squash-merge the
   primary PR and mark the Linear issue `Done`.

Every implementation or review-driven revision requires a new clean-context
review. A same-context self-review is useful preflight but cannot substitute for
the required adversarial review. The maximum is two review rounds total: the
initial review and one post-fix review.

Do not claim manual Messenger, notification, signing, media, or end-to-end
acceptance from source inspection, builds, lint, or packaging alone. Report the
remaining real-device or credential-dependent acceptance step explicitly.

## Daily Codex worker

The single scheduled workflow is `Caprine AI Assist Autonomous Worker`:

- Schedule: every day at 11:00 AM `America/Los_Angeles`.
- Default model: GPT 5.6 Sol with High reasoning.
- Runtime: the local Codex project for `/Users/nccheng/Documents/GitHub/caprine`.
- Per run: resume active lineage first and start at most one new Linear issue.
- Review: one fresh adversarial sub-agent per round, with no more than two rounds.
- Success: green required checks and a clean latest-head review may squash-merge
  and move the issue to `Done`.

Do not create separate selector, writer, reviewer, reconciler, or merge
automations. Do not simulate locks with Linear comments, marker schemas, prompt
hashes, or review digests.

## Development commands and conventions

- Required Node.js version: `>=22.12.0`.
- Electron: `^43.4.0`.
- Build: `npm run build`.
- Lint: `npm run lint`.
- Full automated check: `npm test` (build/type checking plus lint; this
  repository currently has no unit-test runner).
- macOS distribution: `npm run dist:mac`.
- Required issue checks: `npm run build`, `npm run lint`, and
  `git diff --check`, plus any focused checks added by the issue.
- Compiled main output: `dist-js/`; bundled preloads are built by
  `scripts/build-preloads.mjs`.

Use TypeScript and ES module imports where practical, `const` by default,
2-space indentation, no semicolons, and the existing XO/stylelint configuration.
Keep renderer IPC bound to the owning window/main frame and trusted Messenger
origins, validate payloads before native side effects, and never expose
privileged APIs or secrets to the remote page.
