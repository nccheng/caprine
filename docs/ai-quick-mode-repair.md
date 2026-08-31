# Quick replies and reachable Ask AI

The owner reported that `/ai <question>` with Quick mode enabled posted a
question but fell back to review/insert, that repeated commands did not return
an answer, that shared answers lacked AI attribution, and that Ask AI appeared
in the sidebar and could not be reached.

## Corrections and boundaries

- Find the question by its newly observed message ID. Older questions with the
  same text must not prevent replying. Keep uniqueness of that ID, the same
  connected row, and the complete native quote preview as send requirements.
- Prefix Quick answers and manually inserted answers with `Caprine AI Assist`
  and `AI response shared by Derek`. Local answers stay unchanged. Only the
  outgoing answer limit grows by the fixed heading length.
- Place Ask AI beside the message's own text within the conversation bounds,
  excluding quoted text. Keep the button available while the pointer crosses
  the gap from the message to the button.
- Show a failed Quick run at the top of the panel. Distinguish a new keyboard
  or pointer action before a send phase from actual conversation changes.
- A structurally identified native quote preview is not a pending attachment.
  Attachment indicators outside that preview still stop the run; unknown or
  ambiguous composer structures remain blocked.

Quick mode stays opt-in. Panel Ask and Insert remain manual; Insert never
presses Send. Preserve conversation/draft checks, trusted IPC, persisted
one-use send authorization, local diagnostic retention and no automatic retry
of failed or uncertain sends. No bot identity or new provider/media access.

## Evidence and remaining manual acceptance

Read-only local run metadata confirmed failures at quote preparation and
conversation/current-interaction validation after successful model responses.
The current Messenger DOM contained repeated outgoing text and full-width
message rows with much narrower text content. Without sending any message,
the native Reply control and quote-preview structure were inspected and the
temporary previews cancelled.

Two additional attachment failures belonged to another conversation. Their
cause was not reproduced. The quote-preview exclusion is covered by fixtures;
it is not evidence that those historical attachment failures are resolved.

Automated checks exercise two consecutive identical slash questions through
the real controller, in-memory history and send executor with a simulated
Messenger adapter and provider: each answer quotes its own new question, is
attributed, and completes without manual fallback. Other regressions cover
duplicate IDs, maximum-size answer IPC, manual attribution, quote images versus
pending attachments, header failure visibility and Ask AI geometry/hover gap.

These tests and DOM observations are not live end-to-end acceptance. After
installing and restarting, the owner still needs to verify two real `/ai`
turns, native quotation/attribution and pointer activation of Ask AI. No real
message or provider request was sent by the agent for this repair.

## Tracking

Duplicate search found no matching Quick issue. Creating the focused Linear
bug was rejected because the workspace exceeded its free issue limit. No
issue was created, deleted or transitioned. The repair PR is the available
tracking record until that external limit is resolved.
