# Quick AI mode

This change implements the owner's August 30 request for an opt-in fast path:
publish the question, ask the configured model, and send its answer as a native
Messenger reply to that exact question, under the owner's account. Manual AI
Assist remains available with its existing review and draft-only behavior.

The local AI panel remains the inspection surface. Each quick run records its
question, frozen model input, model/settings, output, stage times, typed errors,
and observed original/answer identities. Failed, cancelled and interrupted runs
are retained alongside completed runs. Clipboard diagnostics exclude private
content, account/message identities and credentials. Existing local history
deletion removes these records. Run detail is bounded to the most recent 25 per
AI chat; events are bounded per run.
Rejected model input and saved context each have a two-million-character local
diagnostic ceiling. The provider limit stays at 20,000 characters. Inputs beyond
the diagnostic ceiling retain the question and terminal failure, without the
oversized context. Opening the inspection panel preserves an active quick run;
explicit Cancel, closing the panel, disabling AI or losing its conversation
authority still stops it.

An observed outgoing Messenger row proves UI observation, not recipient delivery.
Sending is attempted at most once per question/answer. A timeout, crash or loss
of identity after a send attempt is uncertain and must never auto-retry. A new
user draft, attachment, reply target or conversation invalidates automation.

Quick mode uses the configured 10/20/50-message text context and web-search mode.
It does not automatically fetch image bytes or transcribe audio/video. Media
needs explicit preparation in manual mode. The setting explains this before
activation. No private Meta API, forged bot identity, hidden retry or background
resumption is permitted.

Required validation includes lifecycle/IPC, history migration and deletion,
redaction, stale/duplicate send prevention, native Reply structure and rendered
panel behavior. Synthetic fixtures are not real Messenger acceptance. Real
posting must use an owner-designated safe conversation and synthetic content.

Local validation after integrating the main-branch focus fix: 350 automated
tests, build/type checks, XO/stylelint and
`git diff --check` passed. The native Traditional Chinese Reply/quote structure
was inspected without sending a message. New-panel visual inspection was
blocked by the browser's unavailable admin-policy verification; no alternative
access was attempted. Installed-build and real question/model/quoted-answer
acceptance remain manual-only and are not proven by these tests.

Discovery reviewed `c40f0d5` and produced this bounded Closure Set:

- C1: rejected oversized input must persist a terminal failure plus bounded
  frozen context, without leaving the panel busy. Covered with the real
  controller and SQLite store, asserting zero provider calls and sends.
- C2: opening the inspection panel must preserve the active quick run. Covered
  through the real open/refresh/request path; explicit Cancel still aborts and
  rejects the deliberately late provider response.

Both findings were corrected at `71c8557`. Bounded Closure review returned
PASS, with 78 focused tests independently passing. The later integration of
main's focus fix and delivery-note update did not change those corrections.
