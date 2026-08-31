# Quick mode message identity handoff

The owner reproduced `/ai <question>` on installed revision `78a3f4f`: the
question was posted, the model returned an answer, and the panel opened with
`quote-unavailable (reply)`. This remained broken after PR #50.

## Confirmed cause

Read-only run metadata showed that question observation saved a numeric
optimistic message ID. The current native row had changed to
`<timestamp>@msgr.<same optimistic ID>`. A local comparison confirmed the suffix
matched; no real message IDs or message content are included here. Reply failed
before the first asynchronous native-control wait because its exact ID no
longer existed.

Using the current native ID, the existing native Reply and complete quote
preview checks passed in the installed Messenger DOM. The preview was then
cancelled. No message or provider request was sent by the agent.

## Correction and invariants

The renderer now completes question/answer observation only for the observed
native ID forms (`mid.*` and `<timestamp>@msgr.<offline ID>`), not the disappearing
numeric ID. The existing bounded observation loop waits without sending again.
The model starts only after the question has this usable ID; the exact ID is
then retained in local history and used for the native quote.

Normalize the offline identity of messages present before Send as well. An
older optimistic message becoming native must not look like a new question
just because its text matches. When an older optimistic row exists, a new
`mid.*` cannot be linked safely to it and is not accepted as proof of this send.
Unknown or unacknowledged IDs time out as uncertain, with no retry. Native UI
observation still does not independently prove recipient delivery.

No change to Quick defaults, panel Ask/Insert, attribution, source selection,
provider access, history retention, conversation/draft guards, persisted
one-use send authorization, or exact quote validation. Old runs are not resumed.

## Validation and limits

- Full tests cover numeric-to-native row replacement for questions and answers,
  older identical messages acknowledging later, unknown/unacknowledged IDs,
  duplicate observations and no retries.
- Consecutive identical-command coverage uses the real controller, history and
  executor with simulated provider/DOM adapters. It now changes each ID during
  observation and asserts no model call before the question ID is native.
- The corrected observation function was also checked against the current
  Messenger DOM without sending: it selects the exact native target and
  excludes it when its older optimistic alias is in the before-Send set.

These checks do not prove a new live end-to-end send. After install/restart,
the owner still needs to verify two `/ai` turns and the sent native quoted,
attributed answers. Slow or unsupported acknowledgement still fails closed.

Linear duplicate search found no matching Quick issue. Focused issue creation
was rejected by the workspace free issue limit; no issue was created or
transitioned. The PR remains the tracking record for this repair.
