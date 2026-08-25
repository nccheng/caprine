# Sanitized Messenger context fixtures

These JSON files model only the DOM semantics consumed by
`source/messenger-context.ts`. They are deterministic test inputs, not captured
Messenger pages and not a browser simulator.

To add or update a fixture:

1. Reproduce the relevant element nesting with `tag`, `attributes`, `text`, and
   `children`; keep the smallest tree that exercises the adapter contract.
2. Replace all names, message text, IDs, timestamps, and links with invented
   values. Never include cookies, tokens, authenticated URLs, account IDs, or
   private conversation content.
3. Add an exact normalized expectation and exercise it through
   `extractLoadedMessengerConversationContext` or
   `extractLoadedMessengerConversationTail`.
4. Keep real-client observations and acceptance evidence in BUI-233. A passing
   fixture does not claim that current Messenger DOM behavior was verified.
5. Run `npm test` and `git diff --check`.

The helper intentionally recognizes only selectors used by the Messenger
context adapter. Extend that small selector surface only when a production
selector and a sanitized fixture require it.
