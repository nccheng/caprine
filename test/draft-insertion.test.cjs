const test = require('node:test');
const assert = require('node:assert/strict');
const {
	draftInsertionTimeoutResult,
	DraftInsertionAuthorizationState,
	executeDraftInsertion,
	InsertedDraftProvenanceState,
	isRetryableDraftInsertionFailure,
	messengerComposerText,
} = require('../dist-js/draft-insertion.js');

test('draft insertion timeout is conservatively reported as possible partial insertion', () => {
	assert.deepEqual(draftInsertionTimeoutResult, {
		reason: 'partial-insertion',
		status: 'blocked',
	});
});

test('Messenger untouched empty-composer sentinel is empty without discarding authored whitespace', () => {
	assert.equal(messengerComposerText('\n', ''), '');
	assert.equal(messengerComposerText('', ''), '');
	assert.equal(messengerComposerText(' ', ' '), ' ');
	assert.equal(messengerComposerText('\u00A0', '\u00A0'), '\u00A0');
	assert.equal(messengerComposerText('\u200B', '\u200B'), '\u200B');
	assert.equal(messengerComposerText('\n', '\n'), '\n');
	assert.equal(messengerComposerText('\n\n', ''), '\n\n');
	assert.equal(messengerComposerText('Line one\nLine two', 'Line oneLine two'), 'Line one\nLine two');
});

test('only pre-mutation draft insertion failures are retryable', () => {
	for (const reason of [
		'attachment-present',
		'composer-ambiguous',
		'composer-changed',
		'composer-not-editable',
		'draft-present',
		'focus-failed',
	]) {
		assert.equal(isRetryableDraftInsertionFailure(reason), true, reason);
	}

	for (const reason of ['conversation-changed', 'partial-insertion', 'stale-authorization']) {
		assert.equal(isRetryableDraftInsertionFailure(reason), false, reason);
	}
});

const snapshot = (overrides = {}) => ({
	captureGeneration: 3,
	conversationId: 'messenger-thread:alpha',
	messengerWebContentsId: 7,
	sessionId: 'ai-session-2',
	...overrides,
});

const authorization = (overrides = {}) => ({
	answerGeneration: 4,
	authorizationToken: 'draft-insertion-token:00000000-0000-4000-8000-000000000001',
	conversationId: 'messenger-thread:alpha',
	question: 'Original question https://www.facebook.com/reel/1744555046768453',
	snapshot: snapshot(),
	text: 'Private AI answer',
	...overrides,
});

function insertionHarness() {
	const composer = {
		attachment: false,
		editable: true,
		focused: false,
		text: '',
	};
	const state = {
		authorized: true,
		composer,
		composers: [composer],
		conversationId: 'messenger-thread:alpha',
		focusSucceeds: true,
		insertions: 0,
		partial: false,
		sends: 0,
		settleCount: 0,
		settleHooks: new Map(),
	};
	const adapter = {
		currentConversationId: () => state.conversationId,
		focus(candidate) {
			if (!state.focusSucceeds) {
				return false;
			}

			candidate.focused = true;
			return true;
		},
		hasPendingAttachment: candidate => candidate.attachment,
		insertText(candidate, text) {
			state.insertions += 1;
			candidate.text = state.partial ? text.slice(0, -1) : text;
		},
		isAuthorized: () => state.authorized,
		isEditable: candidate => candidate.editable,
		readText: candidate => candidate.text,
		resolveComposer() {
			if (state.composers.length === 0) {
				return {status: 'unavailable'};
			}

			if (state.composers.length > 1) {
				return {status: 'ambiguous'};
			}

			return {composer: state.composers[0], status: 'unique'};
		},
		async settle() {
			state.settleCount += 1;
			state.settleHooks.get(state.settleCount)?.();
		},
	};
	return {adapter, composer, state};
}

test('draft insertion authorization is conversation-bound, generation-bound, and one-shot', () => {
	const state = new DraftInsertionAuthorizationState();
	const issued = authorization();
	assert.deepEqual(state.issue(issued), {
		answerGeneration: issued.answerGeneration,
		authorizationToken: issued.authorizationToken,
		conversationId: issued.conversationId,
	});
	assert.equal(state.read(snapshot({captureGeneration: 4})), undefined);
	assert.equal(state.consume({...issued, authorizationToken: 'draft-insertion-token:00000000-0000-4000-8000-000000000002'}, snapshot()), undefined);
	assert.ok(state.read(snapshot()));
	assert.equal(state.consume({...issued, answerGeneration: 5}, snapshot()), undefined);
	assert.ok(state.read(snapshot()));
	assert.equal(state.consume({...issued, conversationId: 'messenger-thread:beta'}, snapshot()), undefined);
	assert.ok(state.read(snapshot()));
	assert.deepEqual(state.consume(issued, snapshot()), issued);
	assert.equal(state.consume(issued, snapshot()), undefined);
});

test('stale snapshot invalidates a draft insertion authorization', () => {
	const state = new DraftInsertionAuthorizationState();
	const issued = authorization();
	state.issue(issued);
	assert.equal(state.consume(issued, snapshot({conversationId: 'messenger-thread:beta'})), undefined);
	assert.equal(state.read(snapshot()), undefined);
});

test('safe insertion failure gets a fresh one-shot token without replacing newer authority', () => {
	const state = new DraftInsertionAuthorizationState();
	const first = authorization();
	state.issue(first);
	const attempt = state.consume(first, snapshot());
	assert.ok(attempt);
	const nextToken = 'draft-insertion-token:00000000-0000-4000-8000-000000000002';
	assert.deepEqual(state.reissueAfterSafeFailure(attempt, snapshot(), nextToken), {
		answerGeneration: first.answerGeneration,
		authorizationToken: nextToken,
		conversationId: first.conversationId,
	});
	assert.equal(state.consume(first, snapshot()), undefined);
	assert.equal(state.read(snapshot()).authorizationToken, nextToken);
	assert.deepEqual(state.consume({...first, authorizationToken: nextToken}, snapshot()), {...first, authorizationToken: nextToken});
	assert.equal(state.consume({...first, authorizationToken: nextToken}, snapshot()), undefined);

	const newer = authorization({answerGeneration: 5, authorizationToken: 'draft-insertion-token:newer'});
	state.issue(newer);
	assert.equal(state.reissueAfterSafeFailure(first, snapshot(), 'draft-insertion-token:old-retry'), undefined);
	assert.deepEqual(state.read(snapshot()), {
		answerGeneration: newer.answerGeneration,
		authorizationToken: newer.authorizationToken,
		conversationId: newer.conversationId,
	});
	assert.equal(state.reissueAfterSafeFailure(first, snapshot({captureGeneration: 4}), nextToken), undefined);
});

test('inserted draft provenance bypasses one exact send and invalidates on edits or mismatch', () => {
	const composer = {};
	const state = new InsertedDraftProvenanceState();
	state.mark(composer, 'messenger-thread:alpha', '/ai literal answer');
	assert.equal(state.matches(composer, 'messenger-thread:alpha', '/ai literal answer'), true);
	assert.equal(state.consume(composer, 'messenger-thread:alpha', '/ai literal answer'), true);
	assert.equal(state.consume(composer, 'messenger-thread:alpha', '/ai literal answer'), false);

	state.mark(composer, 'messenger-thread:alpha', '/ai literal answer');
	assert.equal(state.consume(composer, 'messenger-thread:alpha', '/ai edited'), false);
	assert.equal(state.matches(composer, 'messenger-thread:alpha', '/ai literal answer'), false);

	state.mark(composer, 'messenger-thread:alpha', '/ai literal answer');
	assert.equal(state.consume({}, 'messenger-thread:alpha', '/ai literal answer'), false);
});

test('draft insertion inserts once, verifies the full draft, leaves focus, and never sends', async () => {
	const {adapter, composer, state} = insertionHarness();
	assert.deepEqual(await executeDraftInsertion('messenger-thread:alpha', 'Private AI answer', adapter), {status: 'inserted'});
	assert.equal(composer.text, 'Private AI answer');
	assert.equal(composer.focused, true);
	assert.equal(state.insertions, 1);
	assert.equal(state.sends, 0);
});

test('draft insertion blocks existing drafts, attachments, ambiguous composers, and failed focus without mutation', async () => {
	await Promise.all([
		{
			reason: 'draft-present',
			setup(harness) {
				harness.composer.text = 'Derek draft';
			},
		},
		{
			reason: 'attachment-present',
			setup(harness) {
				harness.composer.attachment = true;
			},
		},
		{
			reason: 'composer-ambiguous',
			setup(harness) {
				harness.state.composers.push({...harness.state.composer});
			},
		},
		{
			reason: 'focus-failed',
			setup(harness) {
				harness.state.focusSucceeds = false;
			},
		},
	].map(async scenario => {
		const harness = insertionHarness();
		scenario.setup(harness);
		assert.deepEqual(
			await executeDraftInsertion('messenger-thread:alpha', 'Answer', harness.adapter),
			{reason: scenario.reason, status: 'blocked'},
		);
		assert.equal(harness.state.insertions, 0);
	}));
});

test('draft insertion revalidates conversation before focus, before mutation, and after mutation', async () => {
	const initial = insertionHarness();
	initial.state.conversationId = 'messenger-thread:beta';
	assert.deepEqual(
		await executeDraftInsertion('messenger-thread:alpha', 'Answer', initial.adapter),
		{reason: 'conversation-changed', status: 'blocked'},
	);
	assert.equal(initial.state.insertions, 0);

	const beforeMutation = insertionHarness();
	beforeMutation.state.settleHooks.set(1, () => {
		beforeMutation.state.conversationId = 'messenger-thread:beta';
	});
	assert.deepEqual(
		await executeDraftInsertion('messenger-thread:alpha', 'Answer', beforeMutation.adapter),
		{reason: 'conversation-changed', status: 'blocked'},
	);
	assert.equal(beforeMutation.state.insertions, 0);

	const afterMutation = insertionHarness();
	afterMutation.state.settleHooks.set(2, () => {
		afterMutation.state.conversationId = 'messenger-thread:beta';
	});
	assert.deepEqual(
		await executeDraftInsertion('messenger-thread:alpha', 'Answer', afterMutation.adapter),
		{reason: 'partial-insertion', status: 'blocked'},
	);
	assert.equal(afterMutation.state.insertions, 1);
});

test('draft insertion cancellation before mutation fails closed without changing the composer', async () => {
	const cancelled = insertionHarness();
	cancelled.state.settleHooks.set(1, () => {
		cancelled.state.authorized = false;
	});
	assert.deepEqual(
		await executeDraftInsertion('messenger-thread:alpha', 'Answer', cancelled.adapter),
		{reason: 'stale-authorization', status: 'blocked'},
	);
	assert.equal(cancelled.state.insertions, 0);
});

test('draft insertion invalidation after mutation is reported as partial insertion', async () => {
	const cancelled = insertionHarness();
	cancelled.state.settleHooks.set(2, () => {
		cancelled.state.authorized = false;
	});
	assert.deepEqual(
		await executeDraftInsertion('messenger-thread:alpha', 'Answer', cancelled.adapter),
		{reason: 'partial-insertion', status: 'blocked'},
	);
	assert.equal(cancelled.state.insertions, 1);
});

test('draft insertion detects composer replacement before and after mutation', async () => {
	const beforeMutation = insertionHarness();
	beforeMutation.state.settleHooks.set(1, () => {
		beforeMutation.state.composers = [{...beforeMutation.composer}];
	});
	assert.deepEqual(
		await executeDraftInsertion('messenger-thread:alpha', 'Answer', beforeMutation.adapter),
		{reason: 'composer-changed', status: 'blocked'},
	);
	assert.equal(beforeMutation.state.insertions, 0);

	const afterMutation = insertionHarness();
	afterMutation.state.settleHooks.set(2, () => {
		afterMutation.state.composers = [{...afterMutation.composer}];
	});
	assert.deepEqual(
		await executeDraftInsertion('messenger-thread:alpha', 'Answer', afterMutation.adapter),
		{reason: 'partial-insertion', status: 'blocked'},
	);
	assert.equal(afterMutation.state.insertions, 1);
});

test('draft insertion reports partial text and editability loss instead of success', async () => {
	const partial = insertionHarness();
	partial.state.partial = true;
	assert.deepEqual(
		await executeDraftInsertion('messenger-thread:alpha', 'Answer', partial.adapter),
		{reason: 'partial-insertion', status: 'blocked'},
	);

	const detached = insertionHarness();
	detached.state.settleHooks.set(2, () => {
		detached.composer.editable = false;
	});
	assert.deepEqual(
		await executeDraftInsertion('messenger-thread:alpha', 'Answer', detached.adapter),
		{reason: 'partial-insertion', status: 'blocked'},
	);

	const focusLost = insertionHarness();
	focusLost.state.settleHooks.set(2, () => {
		focusLost.state.focusSucceeds = false;
	});
	assert.deepEqual(
		await executeDraftInsertion('messenger-thread:alpha', 'Answer', focusLost.adapter),
		{reason: 'partial-insertion', status: 'blocked'},
	);

	const unavailable = insertionHarness();
	unavailable.state.settleHooks.set(2, () => {
		unavailable.state.composers = [];
	});
	assert.deepEqual(
		await executeDraftInsertion('messenger-thread:alpha', 'Answer', unavailable.adapter),
		{reason: 'partial-insertion', status: 'blocked'},
	);
});
