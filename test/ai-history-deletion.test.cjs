const assert = require('node:assert/strict');
const test = require('node:test');
const {AiHistoryDeletionAuthorizationState} = require('../dist-js/ai-history-deletion.js');

const snapshot = (overrides = {}) => ({
	captureGeneration: 4,
	conversationId: 'messenger-thread:one',
	messengerWebContentsId: 7,
	sessionId: 'ai-session-1',
	...overrides,
});

const details = {
	confirmLabel: 'Delete AI chat',
	message: 'Exact scope',
	title: 'Delete?',
};

test('history deletion authorization detaches and preserves the exact selected target', () => {
	const state = new AiHistoryDeletionAuthorizationState(() => 'history-deletion-token:one');
	const capturedSnapshot = snapshot();
	state.issue({chatId: 'chat-1', scope: 'chat', snapshot: capturedSnapshot}, details);
	capturedSnapshot.conversationId = 'messenger-thread:changed';

	assert.deepEqual(state.confirmation, {
		authorizationToken: 'history-deletion-token:one',
		confirmLabel: details.confirmLabel,
		message: details.message,
		scope: 'chat',
		title: details.title,
	});
	assert.deepEqual(state.consume('history-deletion-token:one', snapshot()), {
		status: 'authorized',
		target: {chatId: 'chat-1', scope: 'chat', snapshot: snapshot()},
	});
});

test('conversation changes reject and consume a pending scoped deletion', () => {
	const state = new AiHistoryDeletionAuthorizationState(() => 'history-deletion-token:two');
	state.issue({scope: 'conversation', snapshot: snapshot()}, details);

	assert.deepEqual(state.consume(
		'history-deletion-token:two',
		snapshot({conversationId: 'messenger-thread:other'}),
	), {status: 'rejected'});
	assert.deepEqual(state.consume('history-deletion-token:two', snapshot()), {status: 'rejected'});
});

test('authorization tokens are one-shot and cancellation is exact', () => {
	const state = new AiHistoryDeletionAuthorizationState(() => 'history-deletion-token:three');
	state.issue({scope: 'all'}, details);
	assert.equal(state.cancel('history-deletion-token:stale'), false);
	assert.equal(state.confirmation.authorizationToken, 'history-deletion-token:three');
	assert.equal(state.cancel('history-deletion-token:three'), true);
	assert.equal(state.confirmation, undefined);
	assert.deepEqual(state.consume('history-deletion-token:three'), {status: 'rejected'});

	state.issue({scope: 'all'}, details);
	assert.deepEqual(state.consume('history-deletion-token:three'), {
		status: 'authorized',
		target: {scope: 'all'},
	});
	assert.deepEqual(state.consume('history-deletion-token:three'), {status: 'rejected'});
});
