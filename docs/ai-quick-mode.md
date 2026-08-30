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

Tracking publication is pending explicit authorization: the Linear issue-create
attempt was rejected by the external-write review. No issue was created.
