const test = require('node:test');
const assert = require('node:assert/strict');
const {
	DraftInsertionAuthorizationState,
	executeDraftInsertion,
} = require('../dist-js/draft-insertion.js');

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
		{reason: 'conversation-changed', status: 'blocked'},
	);
	assert.equal(afterMutation.state.insertions, 1);
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
		{reason: 'composer-changed', status: 'blocked'},
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
		{reason: 'focus-failed', status: 'blocked'},
	);
});
